// Pure policy for desktop schedules and their standing approvals (spec docs/spec/command-bus.md section 9). No I/O.
// A kind is schedulable only when it is listed here, available and T1: T2 always needs a click with its exact ids
// confirmed, and T0 has its own enable flag. Add kinds one at a time, each with an explicit-scope rule below.
import { kindInfo } from './registry.mjs';
import { validate } from './schema-validate.mjs';
import { SCHEDULE_LIMITS } from '../../kb/bus-schedules.mjs';

export const SCHEDULABLE_KINDS = Object.freeze(['sources.update']);
export const STANDING_DEFAULT_DAYS = 30;
// The arg that names a standing approval's scope. "Every source" would grow with each new connection, so a standing
// approval must list the ids it covers.
const EXPLICIT_SCOPE = Object.freeze({ 'sources.update': 'sourceIds' });
const FIELDS = new Set(['kind', 'args', 'intervalHours', 'standing', 'standingDays']);

export function parseScheduleBody(body) {
  const bad = (message, details) => ({ ok: false, message, ...(details ? { details } : {}) });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be a JSON object');
  for (const k of Object.keys(body)) if (!FIELDS.has(k)) return bad(`unknown field ${k.slice(0, 40)}`);
  const { kind, args = {}, intervalHours, standing = false, standingDays } = body;
  const info = typeof kind === 'string' && SCHEDULABLE_KINDS.includes(kind) ? kindInfo(kind) : null;
  if (!info || !info.available || info.tier !== 'T1') return bad('this kind cannot be scheduled');
  if (!args || typeof args !== 'object' || Array.isArray(args)) return bad('args must be an object');
  const problems = validate(info.args, args, {}, '.args');
  if (problems.length) return bad('args are not valid', { errors: problems.slice(0, 10) });
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) return bad('intervalHours must be an integer from 1 to 168');
  if (typeof standing !== 'boolean') return bad('standing must be a boolean');
  if (!standing) {
    if (standingDays !== undefined) return bad('standingDays needs standing: true');
    return { ok: true, value: { kind, args, intervalMs: intervalHours * 3_600_000, standingDays: null } };
  }
  const days = standingDays ?? STANDING_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > SCHEDULE_LIMITS.maxStandingDays) return bad(`standingDays must be an integer from 1 to ${SCHEDULE_LIMITS.maxStandingDays}`);
  const scope = EXPLICIT_SCOPE[kind];
  if (!Array.isArray(args[scope]) || args[scope].length === 0) return bad(`a standing approval needs the exact ${scope} it covers`);
  return { ok: true, value: { kind, args, intervalMs: intervalHours * 3_600_000, standingDays: days } };
}

/** Why `schedule`'s standing approval may NOT approve `cmd` now (a fixed reason code), or null when it may. */
export function standingRefusal({ schedule, cmd, argsHash, now = Date.now() }) {
  if (!schedule) return 'no_schedule';
  if (!schedule.standing || !schedule.standingUntil || Date.parse(schedule.standingUntil) <= now) return 'standing_expired';
  if (cmd.originClient !== 'desktop-ui') return 'origin';
  if (cmd.tier !== 'T1' || kindInfo(cmd.kind)?.tier !== 'T1') return 'tier';
  if (cmd.kind !== schedule.kind || argsHash !== schedule.argsHash) return 'scope';
  if (typeof cmd.idem !== 'string' || !cmd.idem.startsWith(`sched:${schedule.id}:`)) return 'not_scheduled';
  if (schedule.lastRunAt && now - Date.parse(schedule.lastRunAt) < schedule.intervalMs / 2) return 'too_soon';
  return null;
}
