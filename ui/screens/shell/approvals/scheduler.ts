// The desktop scheduler for bus schedules (docs/spec/command-bus.md section 9). The core has no timer: this tick
// enqueues each schedule's current slot as the desktop (idempotent per slot) and approves it ONLY on a live standing
// approval, with the nonce from GET /bus/approvals. Everything else waits in the inbox for a click.
// shortcut: runs only while the app runs (a hidden window too); a missed slot is not back-filled, only the current one runs.
import { core } from "../runtime";
import { busApi, rec, type BusApi, type BusSchedule, type EnqueueFrame, type PendingApproval } from "./bus-api";

export const SCHEDULE_TICK_MS = 60_000;
const HOUR = 3_600_000;

export const slotOf = (s: BusSchedule, nowMs: number): number => Math.floor(nowMs / (s.intervalHours * HOUR));
export const idemFor = (s: BusSchedule, nowMs: number): string => `sched:${s.id}:${slotOf(s, nowMs)}`;
const sameArgs = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface SchedulerDeps {
  now(): number;
  schedules(): Promise<BusSchedule[]>;
  enqueue(f: EnqueueFrame): Promise<unknown>;
  approvals(): Promise<PendingApproval[]>;
  approve(a: PendingApproval, extra: { scheduleId: string }): Promise<unknown>;
}

export async function runSchedulesOnce(d: SchedulerDeps): Promise<{ enqueued: string[]; approved: string[]; errors: string[] }> {
  const out = { enqueued: [] as string[], approved: [] as string[], errors: [] as string[] };
  const now = d.now();
  let pending: PendingApproval[] | null = null;
  for (const s of await d.schedules()) {
    try {
      // The core refuses a standing approval within half an interval of the last run (`too_soon`). Wait for that
      // window to pass before enqueueing at all: otherwise every tick re-asks, writing a denied audit row and an
      // "approval needed" notice for a run that later goes through on its own.
      const standingLive = s.standing && s.standingUntil !== null && Date.parse(s.standingUntil) > now;
      if (standingLive && s.lastRunAt !== null && now - Date.parse(s.lastRunAt) < (s.intervalHours * HOUR) / 2) continue;
      const res = await d.enqueue({ kind: s.kind, args: s.args, idem: idemFor(s, now), ttlMs: Math.min(s.intervalHours * HOUR, 24 * HOUR) });
      const cmd = rec(res) && rec(res.command) ? res.command : null;
      if (!cmd || typeof cmd.id !== "string") continue;
      if (!(rec(res) && res.deduped === true)) out.enqueued.push(s.id);
      const live = s.standing && s.standingUntil !== null && Date.parse(s.standingUntil) > now;
      if (cmd.state !== "awaiting_approval" || !live) continue;
      pending ??= await d.approvals();
      const item = pending.find((p) => p.id === cmd.id);
      // The core checks all of this again; checking here keeps a mismatch from ever being sent.
      if (!item || item.kind !== s.kind || item.originClient !== "desktop-ui" || !sameArgs(item.args, s.args)) continue;
      await d.approve(item, { scheduleId: s.id });
      out.approved.push(s.id);
    } catch (e) {
      out.errors.push(`${s.id}:${e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "error"}`);
    }
  }
  return out;
}

const defaultApi = (): BusApi => busApi((path, init) => core.requestRaw(path, init ?? {}));

/** Start the tick; returns a stop function. Idle unless the core sees this UI as `desktop-ui` (a spawned, proven core). */
export function startBusScheduler(api: BusApi = defaultApi(), tickMs = SCHEDULE_TICK_MS): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if ((await api.kindsClient()) !== "desktop-ui") return;
      await runSchedulesOnce({ now: Date.now, schedules: api.schedules, enqueue: api.enqueue, approvals: api.approvals, approve: api.approve });
    } catch {
      // the next tick retries; a slot's idem makes a retry safe
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(() => void tick(), tickMs);
  void tick();
  return () => { stopped = true; window.clearInterval(timer); };
}
