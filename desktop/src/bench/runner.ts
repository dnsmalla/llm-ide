// Sequential bench runner for the Bench tab ("Run all") and autobench modes `all` / `ax`.
// A view-backed step navigates to its tab; the view claims the step on mount and reports
// back when its bench has finished. The AX step is a plain Tauri command.
import { invoke } from "@tauri-apps/api/core";
import { addRecords, clearRecords, emitBench, markInvalidFrom, recordCount, type BenchRecord } from "./records";
import { startFocusMonitor } from "./focus";

export const ALL_STEPS = ["graph", "editor", "terminal", "chat", "ax"] as const;
export type BenchStep = (typeof ALL_STEPS)[number];

/** Tab that hosts each step; the AX probe has no view. */
const TAB_FOR: Record<BenchStep, string | null> = { graph: "graph", editor: "editor", terminal: "terminal", chat: "chat", ax: null };
/** Per-step hang cap (the views' own watchdogs are shorter; this covers a view that never mounts). */
const STEP_CAP_MS: Record<BenchStep, number> = { graph: 240_000, editor: 90_000, terminal: 150_000, chat: 300_000, ax: 30_000 };
/** Whole-run watchdog, sized for the sum of the steps. */
export const RUN_CAP_MS = 15 * 60_000;
/** After a timed-out step, the runner waits this long for the view to stop before the next step. */
const CANCEL_GRACE_MS = 5_000;

/** Steps whose view timed out in this run; views check this to stop their remaining work. */
const cancelled = new Set<BenchStep>();

export function isStepCancelled(step: BenchStep): boolean {
  return cancelled.has(step);
}

/** Resolves with the value, or null when `ms` elapses first. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface Active {
  step: BenchStep;
  claimed: boolean;
  finish: (error?: string) => void;
}

export interface RunState {
  running: boolean;
  step: BenchStep | null;
  done: number;
  total: number;
}

/** Shape of the Rust `ax_probe` result (see src-tauri/src/ax_probe.rs). */
export interface AxProbeResult {
  status: "ok" | "permission_denied" | "unsupported" | "no_focused_window";
  samples: number;
  ax_read_ms_p50: number;
  ax_read_ms_max: number;
  ax_elements: number;
}

let active: Active | null = null;
let navigator: ((tab: string) => void) | null = null;
let state: RunState = { running: false, step: null, done: 0, total: 0 };
const listeners = new Set<() => void>();
const singleStarted = new Set<string>();

function setState(next: RunState): void {
  state = next;
  for (const l of listeners) l();
}

/** The App registers its section setter so the runner can switch tabs. */
export function setBenchNavigator(fn: (tab: string) => void): void {
  navigator = fn;
}

export function getRunState(): RunState {
  return state;
}

export function subscribeRunState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface StepStart {
  /** True when the runner drives this step (the view reports back via finishStep). */
  run: boolean;
  /** True for a single-mode autobench (LLMIDE_POC_AUTOBENCH=<step>): the app exits afterwards. */
  exitAfter: boolean;
}

/**
 * Called by a view when its bench could start. Returns null when the view should stay idle:
 * the runner did not ask for this step and the launch is not that step's single autobench.
 */
export function claimStep(step: BenchStep, autobenchMode: string | null): StepStart | null {
  if (active && active.step === step && !active.claimed) {
    active.claimed = true;
    return { run: true, exitAfter: false };
  }
  if (autobenchMode === step && !singleStarted.has(step)) {
    singleStarted.add(step);
    return { run: false, exitAfter: true };
  }
  return null;
}

/** Called by a view when its bench has ended (after its error and diagnostics records). */
export async function finishStep(start: StepStart, step: BenchStep, error?: string): Promise<void> {
  if (start.run) {
    if (active && active.step === step) active.finish(error);
    return;
  }
  await invoke("bench_done").catch(() => undefined);
}

function runViewStep(step: BenchStep, tab: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (active?.step === step) active = null;
      // Signal the view to stop, and move its tab away so it unmounts (its cleanup stops the
      // shell or editor). The runner waits CANCEL_GRACE_MS before the next step.
      cancelled.add(step);
      navigator?.("bench");
      resolve(`timeout: ${step} did not finish within ${STEP_CAP_MS[step] / 1000} s`);
    }, STEP_CAP_MS[step]);
    active = {
      step,
      claimed: false,
      finish: (error) => {
        clearTimeout(timer);
        active = null;
        resolve(error);
      },
    };
    navigator?.(tab);
  });
}

/** Runs the AX probe under its time cap; a probe that does not return in time is a timeout error. */
async function runAxStep(): Promise<string | undefined> {
  const result = await withTimeout(invoke<AxProbeResult>("ax_probe"), STEP_CAP_MS.ax);
  if (result === null) {
    cancelled.add("ax");
    return `timeout: ax probe did not finish within ${STEP_CAP_MS.ax / 1000} s`;
  }
  const records: BenchRecord[] = [{ name: "ax", value: result.status === "ok" ? 1 : 0, unit: "status", status: result.status }];
  if (result.status === "ok") {
    records.push(
      { name: "ax_read_ms_p50", value: result.ax_read_ms_p50, unit: "ms", samples: result.samples },
      { name: "ax_read_ms_max", value: result.ax_read_ms_max, unit: "ms", samples: result.samples },
      { name: "ax_elements", value: result.ax_elements, unit: "count" },
    );
  }
  addRecords(records);
  return undefined;
}

/**
 * Runs the steps in order. `exitWhenDone` (autobench) emits bench_all_done and exits through
 * bench_done; otherwise the Bench tab is shown again with the table. Only one run at a time.
 */
export async function runSteps(steps: readonly BenchStep[], exitWhenDone: boolean): Promise<void> {
  if (state.running) return;
  clearRecords();
  cancelled.clear();
  const started = performance.now();
  setState({ running: true, step: null, done: 0, total: steps.length });
  const failed: string[] = [];
  const watchdog = setTimeout(() => {
    void emitBench({ name: "bench_all_error", value: 0, unit: "error", message: `watchdog: run not finished after ${RUN_CAP_MS} ms` });
    if (exitWhenDone) void invoke("bench_done").catch(() => undefined);
  }, RUN_CAP_MS);
  try {
    for (const [i, step] of steps.entries()) {
      setState({ running: true, step, done: i, total: steps.length });
      const tab = TAB_FOR[step];
      const monitor = startFocusMonitor();
      const from = recordCount();
      const error = tab ? await runViewStep(step, tab) : await runAxStep().catch((e: unknown) => String(e));
      const focus = monitor();
      // Records taken while the window was hidden or unfocused are kept, but marked not valid.
      if (!focus.valid) markInvalidFrom(from);
      await emitBench({ name: `${step}_focus_lost_ms`, value: focus.lostMs, unit: "ms" }).catch(() => undefined);
      if (error) {
        failed.push(step);
        await emitBench({ name: `${step}_error`, value: 0, unit: "error", message: error }).catch(() => undefined);
        if (cancelled.has(step)) await new Promise((r) => setTimeout(r, CANCEL_GRACE_MS));
      }
    }
  } finally {
    clearTimeout(watchdog);
    const elapsed = Math.round(performance.now() - started);
    await emitBench({
      name: "bench_all_done",
      value: failed.length,
      unit: "steps_failed",
      steps: steps.length,
      elapsed_ms: elapsed,
      failed: failed.length ? failed.join(",") : "none",
    }).catch(() => undefined);
    setState({ running: false, step: null, done: steps.length, total: steps.length });
    if (exitWhenDone) {
      await invoke("bench_done").catch(() => undefined);
    } else {
      navigator?.("bench");
    }
  }
}
