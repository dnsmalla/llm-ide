// Per-turn tool accounting (migration 0035). Best-effort by contract: a
// telemetry write must never break a model turn.
import { getDb, requireUser } from './db.mjs';
import { summarizeToolEventsOn } from './tool-events-summary.mjs';

const MAX_EVENTS_PER_TURN = 200;
const clampInt = (v) => Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(v) || 0)));
const clampStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

export function recordToolEvents(userId, { turnId, engine, mode = null, events } = {}) {
  try {
    requireUser(userId);
    if (typeof turnId !== 'string' || !turnId) return 0;
    if (engine !== 'v2' && engine !== 'legacy') return 0;
    if (!Array.isArray(events) || events.length === 0) return 0;
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO turn_tool_events
         (user_id, turn_id, engine, mode, seq, tool, result_chars, truncated, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    db.transaction(() => {
      events.slice(0, MAX_EVENTS_PER_TURN).forEach((e, seq) => {
        const tool = clampStr(e?.tool, 128);
        if (!tool) return;
        insert.run(userId, clampStr(turnId, 128), engine, clampStr(mode, 32), seq, tool,
          clampInt(e.resultChars), e.truncated ? 1 : 0, e.isError ? 1 : 0);
        written += 1;
      });
    })();
    return written;
  } catch {
    return 0;
  }
}

/** userId null = every user (operator report only). */
export function summarizeToolEvents(userId, opts = {}) {
  if (userId !== null) requireUser(userId);
  return summarizeToolEventsOn(getDb(), userId, opts);
}

export { summarizeToolEventsOn };
