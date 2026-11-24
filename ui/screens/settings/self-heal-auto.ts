// Self-Heal's daily automatic fix run (debug desktop builds). When the user turns it on in Settings → Self-Heal, the
// Shell checks every AUTO_CHECK_MS and, once a local day at or after the chosen time, runs the same fix run as Try to
// fix. Applying a fix stays the user's click. Pure apart from the injected deps, so it is tested with node.
//
// The day is recorded BEFORE the run starts: a reload or a crash mid-run must not start a second 2-hour run that day.
// A busy Loop run or a manual run (409 RUN_ACTIVE) does not use up the day; the check waits AUTO_WAIT_MS instead.
import type { RunResult } from "./self-heal-run.ts";

export const AUTO_CONFIG_KEY = "llmide.selfHeal.auto";
export const AUTO_STATE_KEY = "llmide.selfHeal.autoState";
export const AUTO_CHECK_MS = 5 * 60_000;
export const AUTO_WAIT_MS = 30 * 60_000;
export const DEFAULT_TIME = "12:30";

export interface AutoConfig {
  enabled: boolean;
  /** Local `HH:MM`. */
  time: string;
}
export interface AutoState {
  /** Local `YYYY-MM-DD` of the last day a run was started (or "" for never). */
  lastRunDay: string;
  /** Epoch ms before which no check runs (a busy Loop or manual run). */
  waitUntil: number;
  /** The last automatic run's outcome, for Settings. */
  last: { at: number; message: string } | null;
}
export interface AutoDeps {
  now(): Date;
  config(): AutoConfig;
  state(): AutoState;
  /** False when the state could not be stored (blocked or full storage). */
  save(s: AutoState): boolean;
  /** True once the host said this build records (`selfHealEnabled`). */
  recording(): boolean;
  /** Signed in and the core is ready: a check before that would fail and use up the day. */
  ready(): boolean;
  loopBusy(): boolean;
  /** Ids of the incidents that need a person. */
  needsHuman(): Promise<Set<string>>;
  run(): Promise<RunResult>;
  notify(): Promise<void>;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    return isRec(v) ? v : {};
  } catch {
    return {};
  }
}

/** The saved switch and time; anything unreadable is off at 12:30. */
export function readAutoConfig(raw: string | null): AutoConfig {
  const v = parse(raw);
  return { enabled: v.enabled === true, time: typeof v.time === "string" && TIME.test(v.time) ? v.time : DEFAULT_TIME };
}

export function readAutoState(raw: string | null): AutoState {
  const v = parse(raw);
  const last = isRec(v.last) && typeof v.last.at === "number" && typeof v.last.message === "string" ? { at: v.last.at, message: v.last.message } : null;
  return {
    lastRunDay: typeof v.lastRunDay === "string" ? v.lastRunDay : "",
    waitUntil: typeof v.waitUntil === "number" && Number.isFinite(v.waitUntil) ? v.waitUntil : 0,
    last,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local calendar day of `now`. */
export function dayKey(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether today's run should start now: on, not run today, at or past the time, and not waiting. */
export function isDue(config: AutoConfig, state: AutoState, now: Date): boolean {
  // `>=`, not `===`: after moving west, "today" can be a day the run already used (YYYY-MM-DD sorts as dates).
  if (!config.enabled || state.lastRunDay >= dayKey(now) || now.getTime() < state.waitUntil) return false;
  const [h, m] = (TIME.test(config.time) ? config.time : DEFAULT_TIME).split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

/** The core's "a run is already in progress" (a manual Try to fix): an ApiError or any `{ status, code }`. */
function isRunActive(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { status?: unknown; code?: unknown };
  return o.status === 409 && o.code === "RUN_ACTIVE";
}

const ids = async (d: AutoDeps): Promise<Set<string>> => d.needsHuman().catch(() => new Set<string>());

// In memory on purpose: the run lives in this webview, so a reload ends it and this flag with it. Settings reads it to
// keep Try to fix and Reset away from a run in progress (Reset would delete the worktree the run is using).
let running = false;
const runListeners = new Set<() => void>();
const setRunning = (on: boolean): void => {
  running = on;
  for (const l of [...runListeners]) l();
};
export const autoRunInProgress = (): boolean => running;
export function subscribeAutoRun(l: () => void): () => void {
  runListeners.add(l);
  return () => {
    runListeners.delete(l);
  };
}

/** One check. "ran" also covers a run that failed (the day is used: a down core must not be retried all day). */
export async function autoTickOnce(d: AutoDeps): Promise<"skipped" | "waiting" | "ran"> {
  const now = d.now();
  const prev = d.state();
  if (running || !d.recording() || !d.ready() || !isDue(d.config(), prev, now)) return "skipped";
  const wait = (): "waiting" => {
    d.save({ ...prev, waitUntil: now.getTime() + AUTO_WAIT_MS });
    return "waiting";
  };
  if (d.loopBusy()) return wait();
  // A day that cannot be recorded is not run: otherwise every check would run again.
  if (!d.save({ ...prev, lastRunDay: dayKey(now) })) return "skipped";
  const before = await ids(d);
  let result: RunResult;
  setRunning(true);
  try {
    result = await d.run();
  } catch (e) {
    if (isRunActive(e)) return wait();
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    d.save({ ...d.state(), last: { at: now.getTime(), message: `Self-Heal's daily run failed: ${why}` } });
    return "ran";
  } finally {
    setRunning(false);
  }
  d.save({ ...d.state(), last: { at: now.getTime(), message: result.message } });
  const after = await ids(d);
  if (result.proposed > 0 || [...after].some((id) => !before.has(id))) await d.notify().catch(() => undefined);
  return "ran";
}

// ── Storage: this machine's localStorage. A blocked store reads as off and never throws. ──
function stored(key: string): string | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function store(key: string, value: string): boolean {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    ls.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export const loadAutoConfig = (): AutoConfig => readAutoConfig(stored(AUTO_CONFIG_KEY));
export const loadAutoState = (): AutoState => readAutoState(stored(AUTO_STATE_KEY));
/** False when the switch could not be saved (blocked storage). */
export const saveAutoConfig = (c: AutoConfig): boolean => store(AUTO_CONFIG_KEY, JSON.stringify(c));
export const saveAutoState = (s: AutoState): boolean => store(AUTO_STATE_KEY, JSON.stringify(s));

