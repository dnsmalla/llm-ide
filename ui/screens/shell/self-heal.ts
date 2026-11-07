// Self-Heal capture, webview side (plan A of docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md).
// Debug desktop builds only: the host's `self_heal_take` answers `enabled: false` in a release build, and then
// nothing is kept, posted or shown. In a debug build, every 15 s the pump:
//   1. drains the host's reports (core stderr, panic records);
//   2. adds the Chat and Loop errors this webview reported;
//   3. posts them to the core, which redacts and stores them.
// Incident text is data: it goes only to the core this app trusts and is never handed to a model. Pure apart from the
// injected `take` and `post`, so it is tested with node.

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
  const m = text(message);
  if (!enabled || m === null) return;
  keep([{ source: "ui", category, message: m, stack: null }]);
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
