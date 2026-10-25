// Editor bench: open latency for the 10k-line sample (visibility-gated), TS worker readiness,
// a warm-up, then 200 scripted keystrokes at the end of a mid-file line. Each keystroke is
// measured three ways: time inside the edit call (sync), trigger to the first frame callback
// (paint), and trigger to the second frame (2raf, the old metric).
import { invoke } from "@tauri-apps/api/core";
import type { editor as MonacoEditorNs, Uri } from "monaco-editor";
import { getTypeScriptWorker, workerStats } from "./monacoEnv";
import { SAMPLE_LINES } from "./sampleFile";

type Editor = MonacoEditorNs.IStandaloneCodeEditor;
type TextModel = MonacoEditorNs.ITextModel;

export const KEYSTROKES = 200;
export const WARM_KEYSTROKES = 20;
const IDLE_FRAMES = 60;
/** Cap for each visibility / content wait; a stall past this is recorded, not waited out. */
export const WAIT_CAP_MS = 10_000;
const TYPED = "const value = count + 1; ";

// Document-level CSP violations, counted from module load so nothing before the bench is missed.
let cspViolations = 0;
let firstViolation = "";
document.addEventListener("securitypolicyviolation", (ev) => {
  cspViolations += 1;
  if (!firstViolation) firstViolation = `${ev.effectiveDirective} ${ev.blockedURI}`;
});

/** Emits one measurement as a `BENCH <json>` stdout line via the Rust `bench` command. */
export function emitBench(record: Record<string, string | number>): Promise<void> {
  return invoke("bench", { line: JSON.stringify(record) });
}

/** Resolves after the next frame has been painted (rAF, then a second rAF). */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Nearest-rank percentile of a sorted, non-empty sample set. */
export function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Waits until the document is visible and one frame has painted, capped at WAIT_CAP_MS.
 * Returns the time waited. A hidden or unfocused WKWebView does not run rAF, so the frame
 * wait is raced against the cap too.
 */
export async function waitVisibleAndPainted(): Promise<number> {
  const start = performance.now();
  while (document.visibilityState !== "visible" && performance.now() - start < WAIT_CAP_MS) {
    await sleep(50);
  }
  const left = Math.max(0, WAIT_CAP_MS - (performance.now() - start));
  await Promise.race([nextPaint(), sleep(left)]);
  return performance.now() - start;
}

/**
 * Resolves at the first rendered line (`.view-line` in the host) or at the cap. Uses the DOM,
 * not rAF, so it does not depend on frame callbacks running.
 */
export function waitContentRendered(host: HTMLElement): Promise<{ at: number; via: string }> {
  return new Promise((resolve) => {
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (via: string) => {
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      resolve({ at: performance.now(), via });
    };
    const check = () => {
      if (host.querySelector(".view-line")) {
        done("view-line");
        return true;
      }
      return false;
    };
    if (check()) return;
    observer = new MutationObserver(() => {
      check();
    });
    observer.observe(host, { childList: true, subtree: true });
    timer = setTimeout(() => done("timeout"), WAIT_CAP_MS);
  });
}

/** Timing captured by the EditorView when it creates the editor. */
export interface OpenTiming {
  visibleWaitMs: number;
  visibilityAtT0: string;
  /** performance.now() before createModel. */
  t0: number;
  afterCreate: number;
  stop: number;
  via: string;
}

type TsWorkerFactory = (...uris: Uri[]) => Promise<{ getSemanticDiagnostics(fileName: string): Promise<unknown[]> }>;

/**
 * Runs the editor bench on an already-open editor. Emits BENCH lines; throws on failure.
 */
export async function runEditorBench(editor: Editor, model: TextModel, timing: OpenTiming, sourceBytes: number): Promise<void> {
  await emitBench({ name: "editor_visible_wait_ms", value: round1(timing.visibleWaitMs), unit: "ms" });
  await emitBench({ name: "editor_open_ms", value: round1(timing.stop - timing.t0), unit: "ms", lines: SAMPLE_LINES, bytes: sourceBytes, via: timing.via });
  await emitBench({
    name: "editor_open_trace",
    value: 0,
    unit: "trace",
    t0_ms: round1(timing.t0),
    after_create_ms: round1(timing.afterCreate),
    stop_ms: round1(timing.stop),
    visibility_at_t0: timing.visibilityAtT0,
    via: timing.via,
  });

  // TypeScript worker: one semantic-diagnostics round trip proves the worker runs.
  const getWorker = (await getTypeScriptWorker()) as unknown as TsWorkerFactory;
  const worker = await getWorker(model.uri);
  await worker.getSemanticDiagnostics(model.uri.toString());
  await emitBench({ name: "ts_worker_ready_ms", value: round1(performance.now() - timing.t0), unit: "ms" });

  editor.focus();
  const line = Math.floor(model.getLineCount() / 2);
  editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
  editor.revealLineInCenter(line);
  // Warm-up: unmeasured keystrokes replace a fixed wait.
  for (let i = 0; i < WARM_KEYSTROKES; i += 1) {
    editor.trigger("keyboard", "type", { text: TYPED.charAt(i % TYPED.length) });
    await nextPaint();
  }

  // Display refresh interval: median gap between 60 consecutive idle frames.
  const frameTimes = await new Promise<number[]>((resolve) => {
    const stamps: number[] = [];
    const tick = (ts: number) => {
      stamps.push(ts);
      if (stamps.length > IDLE_FRAMES) resolve(stamps);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const gaps = frameTimes.slice(1).map((t, i) => t - (frameTimes[i] as number));
  const displayFrameMs = percentile([...gaps].sort((a, b) => a - b), 0.5);
  await emitBench({ name: "display_frame_ms", value: round1(displayFrameMs), unit: "ms", frames: gaps.length, stat: "median" });

  const sync: number[] = [];
  const paint: number[] = [];
  const twoRaf: number[] = [];
  for (let i = 0; i < KEYSTROKES; i += 1) {
    const text = TYPED.charAt(i % TYPED.length);
    const t0 = performance.now();
    editor.trigger("keyboard", "type", { text });
    const t1 = performance.now();
    // First frame callback after the edit; read the clock inside it, not the frame timestamp.
    // The 2-rAF probe is registered in the same tick, so both see the same frame sequence.
    const frame = new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now())));
    const second = nextPaint();
    const tFrame = await frame;
    await second;
    const t2 = performance.now();
    sync.push(t1 - t0);
    paint.push(Math.max(0, tFrame - t0));
    twoRaf.push(t2 - t0);
  }
  const stats = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    return { p50: round1(percentile(sorted, 0.5)), p95: round1(percentile(sorted, 0.95)), max: round1(sorted[sorted.length - 1] ?? 0) };
  };
  const common = { unit: "ms", samples: KEYSTROKES, line };
  for (const [prefix, xs] of [
    ["editor_keystroke_2raf", twoRaf],
    ["editor_keystroke_sync", sync],
    ["editor_keystroke_paint", paint],
  ] as const) {
    const st = stats(xs);
    await emitBench({ name: `${prefix}_p50_ms`, value: st.p50, ...common });
    await emitBench({ name: `${prefix}_p95_ms`, value: st.p95, ...common });
    await emitBench({ name: `${prefix}_max_ms`, value: st.max, ...common });
  }
}

/** Final diagnostics: worker errors and document CSP violations seen since module load. */
export async function emitBenchDiagnostics(): Promise<void> {
  const workers = workerStats();
  await emitBench({ name: "editor_workers_created", value: workers.created, unit: "count" });
  await emitBench({ name: "editor_worker_errors", value: workers.errors, unit: "count" });
  await emitBench({
    name: "editor_csp_violations",
    value: cspViolations,
    unit: "count",
    ...(firstViolation ? { first: firstViolation } : {}),
  });
}
