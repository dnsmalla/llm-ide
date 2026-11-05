// Desktop schedules for bus kinds (migration 0063, spec docs/spec/command-bus.md section 9). Data access only, per user:
// every helper takes userId first and filters on it. The policy (which kinds, which args, when a standing approval may
// approve a command) lives in routes/bus/schedules.mjs.
import crypto from 'node:crypto';
import { getDb } from './db.mjs';
import { argsHashOf } from './bus-store.mjs';

export const SCHEDULE_LIMITS = Object.freeze({ maxPerUser: 10, minIntervalMs: 3_600_000, maxIntervalMs: 604_800_000, maxStandingDays: 90 });

const jparse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const shape = (r, now) => (r ? {
  id: r.id, kind: r.kind, args: jparse(r.args_json, {}), argsHash: r.args_hash, intervalMs: r.interval_ms,
  standingUntil: r.standing_until ?? null,
  standing: typeof r.standing_until === 'string' && Date.parse(r.standing_until) > now,
  createdAt: r.created_at, lastRunAt: r.last_run_at ?? null,
} : null);

export function getSchedule(userId, id, now = Date.now()) {
  return shape(getDb().prepare('SELECT * FROM bus_schedules WHERE user_id = ? AND id = ?').get(userId, id), now);
}

export function listSchedules(userId, now = Date.now()) {
  return getDb().prepare('SELECT * FROM bus_schedules WHERE user_id = ? ORDER BY created_at, rowid').all(userId).map((r) => shape(r, now));
}

/** `standingDays` null or 0 = no standing approval (every run waits for a click). */
export function createSchedule(userId, { kind, args, intervalMs, standingDays, now = Date.now() }) {
  const db = getDb();
  return db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM bus_schedules WHERE user_id = ?').get(userId).n;
    if (count >= SCHEDULE_LIMITS.maxPerUser) throw Object.assign(new Error(`at most ${SCHEDULE_LIMITS.maxPerUser} schedules per user`), { code: 'QUOTA_EXCEEDED' });
    const id = crypto.randomUUID();
    const a = args ?? {};
    const until = standingDays ? new Date(now + standingDays * 86_400_000).toISOString() : null;
    db.prepare('INSERT INTO bus_schedules (id, user_id, kind, args_json, args_hash, interval_ms, standing_until) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, kind, JSON.stringify(a), argsHashOf(kind, a), intervalMs, until);
    return getSchedule(userId, id, now);
  })();
}

export function deleteSchedule(userId, id) {
  return getDb().prepare('DELETE FROM bus_schedules WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}
