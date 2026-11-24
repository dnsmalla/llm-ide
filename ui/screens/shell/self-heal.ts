// Self-Heal capture, webview side (plan A).
// Debug desktop builds only: the host's `self_heal_take` answers `enabled: false` in a release build, and then
// nothing is kept, posted or shown. In a debug build, every 15 s the pump:
//   1. drains the host's reports (core stderr, panic records);
//   2. adds what this webview reported: Chat and Loop errors, any section's crash, uncaught errors and unexpected
//      host-command failures;
//   3. posts them to the core it spawned, which redacts and stores them.
// Incident text is data: capture never hands it to a model. Only a Self-Heal fix run (Try to fix, or the daily run the
// user turned on) shows it to the agent, fenced in BATCH.md. Pure apart from the injected deps, so it is tested with node.

import { hostErrorCode, hostErrorText } from "./host-error.ts";

export type IncidentSource = "ui" | "log" | "crash" | "server";
export interface IncidentReport {
  source: IncidentSource;
  category: string;
  message: string;
  stack: string | null;
}
export interface PumpDeps {
  take: () => Promise<unknown>;
  post: (incidents: IncidentReport[]) => Promise<unknown>;
  /** False while the core is not the one this app spawned (remote, SSH, adopted): only that core records incidents. */
  canPost?: () => boolean;
}

export const PENDING_MAX = 100;
export const BATCH_MAX = 50;
export const PUMP_MS = 15_000;
const TEXT_MAX = 20_000;
const SOURCES: ReadonlySet<string> = new Set(["ui", "log", "crash", "server"]);

let enabled = false;
let pending: IncidentReport[] = [];
const listeners = new Set<() => void>();
let lastDeps: PumpDeps | null = null;

/** True once the host said this is a debug build that records (Settings shows the Self-Heal group then). */
export const selfHealEnabled = (): boolean => enabled;
export const pendingCount = (): number => pending.length;

export function subscribeSelfHeal(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (!on) pending = [];
  for (const l of [...listeners]) l();
}

/** Adds reports (at the front for a batch whose post failed); the newest PENDING_MAX survive. */
function keep(items: readonly IncidentReport[], atFront = false): void {
  pending = atFront ? [...items, ...pending] : [...pending, ...items];
  if (pending.length > PENDING_MAX) pending = pending.slice(pending.length - PENDING_MAX);
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.slice(0, TEXT_MAX) : null);

/** Defensive decode of the host's answer: anything malformed reads as off, a malformed report is dropped. */
export function decodeTake(raw: unknown): { enabled: boolean; incidents: IncidentReport[] } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!o || o.enabled !== true) return { enabled: false, incidents: [] };
  const incidents: IncidentReport[] = [];
  for (const it of Array.isArray(o.incidents) ? o.incidents : []) {
    const r = it && typeof it === "object" ? (it as Record<string, unknown>) : null;
    const category = text(r?.category);
    const message = text(r?.message);
    if (!r || typeof r.source !== "string" || !SOURCES.has(r.source) || category === null || message === null) continue;
    incidents.push({ source: r.source as IncidentSource, category, message, stack: typeof r.stack === "string" ? r.stack.slice(0, TEXT_MAX) : null });
  }
  return { enabled: true, incidents };
}

/** A Chat turn failed or a Loop run threw (the Mac's `.ui` "chat" / "loop" incidents). A no-op unless enabled. */
export function reportUiIncident(category: "chat" | "loop", message: unknown): void {
  reportAppError(category, typeof message === "string" ? message : null);
}

/**
 * Any part of the app failed: a section crashed (`section:<name>`), an error went uncaught (`uncaught`) or a host
 * command failed unexpectedly (`host:<command>`). A no-op unless enabled or when there is no message. A report equal
 * to one still pending (same category and message) is dropped, so a crash loop cannot push every other report out.
 */
export function reportAppError(category: string, error: unknown, extraStack?: string): void {
  if (!enabled) return;
  const raw = typeof error === "number" || typeof error === "boolean" ? String(error) : hostErrorText(error);
  const message = text(raw);
  if (message === null) return;
  if (pending.some((p) => p.category === category && p.message === message)) return;
  const parts = [error instanceof Error ? error.stack : undefined, extraStack].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  keep([{ source: "ui", category, message, stack: parts.length > 0 ? parts.join("\n").slice(0, TEXT_MAX) : null }]);
}

// Host error codes that mean the app itself is broken. Every other code is an expected refusal (validation, cancel,
// conflict, rate limit) or the environment (io, SSH, network, keychain) and would bury the real bugs.
const INTERNAL_HOST_CODES: ReadonlySet<string> = new Set([
  "internal", "integrity", "bad_response", "bad_core_response", "session_record_failed", "random_failed", "bundle_missing", "prefs_unavailable",
]);

/** Whether a host command's rejection is a Self-Heal incident: one with an internal code, or one with no code at all. */
export function hostErrorWorthReporting(command: string, error: unknown): boolean {
  if (command.startsWith("self_heal_")) return false; // the pump's own failures would report themselves forever
  // Many `Result<_, String>` commands put their code in the text (`io: …`, `already_recording: …`): read it the same way.
  const prefixed = typeof error === "string" ? /^([a-z][a-z_]*): /.exec(error.trim())?.[1] ?? "" : "";
  const code = hostErrorCode(error) || prefixed;
  if (code !== "") return INTERNAL_HOST_CODES.has(code);
  // An uncoded string is the host's own wording of an expected refusal (168 of them, e.g. "a graph generation is
  // still running"): recording them filled the daily automatic run with non-bugs. A thrown Error is the bridge itself
  // failing on this side, which is a bug.
  return error instanceof Error && hostErrorText(error) !== "";
}

type ErrorTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Reports uncaught errors and unhandled promise rejections on `target` (the window). Returns the remover. */
export function installGlobalErrorCapture(target: ErrorTarget): () => void {
  const onError = (ev: Event): void => {
    const e = ev as Event & { error?: unknown; message?: unknown };
    reportAppError("uncaught", e.error ?? e.message);
  };
  const onRejection = (ev: Event): void => reportAppError("uncaught", (ev as Event & { reason?: unknown }).reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * A problem the user reported from Chat (`/self-heal …`): kept like any other incident but posted now, not on the next
 * 15 s tick, so Settings → Self-Heal shows it at once. False when Self-Heal is off (a release build).
 */
export async function reportChatProblem(message: unknown): Promise<boolean> {
  const m = text(message);
  if (!enabled || m === null) return false;
  keep([{ source: "ui", category: "chat report", message: m, stack: null }]);
  if (lastDeps) await pumpOnce(lastDeps);
  return true;
}

/** One tick: take from the host, then post everything pending in batches; a failed post keeps the rest for later. */
export async function pumpOnce(deps: PumpDeps): Promise<void> {
  let take: ReturnType<typeof decodeTake>;
  try {
    take = decodeTake(await deps.take());
  } catch {
    return;
  }
  setEnabled(take.enabled);
  if (!take.enabled) return;
  keep(take.incidents);
  if (deps.canPost && !deps.canPost()) return; // kept (newest PENDING_MAX) until the spawned core is back
  while (pending.length > 0) {
    const batch = pending.slice(0, BATCH_MAX);
    pending = pending.slice(batch.length);
    try {
      await deps.post(batch);
    } catch {
      keep(batch, true); // signed out, core restarting or an adopted core without the switch: try again next tick
      return;
    }
  }
}

/** Starts the pump; it stops by itself after a release build's first answer. Returns the stop function. */
export function startSelfHealPump(deps: PumpDeps, intervalMs = PUMP_MS): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  lastDeps = deps;
  const tick = async (): Promise<void> => {
    await pumpOnce(deps);
    if (!stopped && enabled) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (lastDeps === deps) lastDeps = null;
    if (timer !== null) clearTimeout(timer);
  };
}

export function resetSelfHealForTests(): void {
  lastDeps = null;
  enabled = false;
  pending = [];
  listeners.clear();
}

/**
 * A Self-Heal fix run's last step (plan B): after `waitMs` (the host settles a stack trace after 2 s of quiet), drain
 * the host and post once more through the running pump, while the core still holds the run open and drops the run's
 * own reports. A no-op without a running pump.
 */
export async function flushSelfHealNow(waitMs = 2_500): Promise<void> {
  const deps = lastDeps;
  if (!deps) return;
  await new Promise((r) => setTimeout(r, waitMs));
  await pumpOnce(deps);
}
