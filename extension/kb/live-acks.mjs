// The ack ledger for finalized extension meetings (live-then-archive plan 3.6 B,
// Phase 1 T1.3). A finalized capture is released only when the Mac app has
// written and verified its file and acknowledged it. The row holds ids and a
// hash, never the transcript, so it is safe to keep indefinitely: an acked id
// keeps answering "acked", which is what lets the extension drop its draft.
//
// The durable crash row for a finalized capture is an ordinary `meetings` row
// tagged meta.liveState = 'finalized' (written only when the LLMIDE_LIVE_ACK
// flag is on). It survives a server restart, which the in-memory ring buffer
// does not.
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { errValidation } from '../core/errors.mjs';

export const FINALIZED_TAG = '"liveState":"finalized"';

export function getLiveAck(userId, sessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(),
    'SELECT session_id, note_key, content_hash, lines, acked_at FROM live_acks WHERE owner_user_id = ? AND session_id = ?',
  ).get(userId, sessionId) ?? null;
}

/**
 * Record an ack. Idempotent: a second ack for the same session returns the
 * first row unchanged.
 */
export function recordLiveAck(userId, sessionId, { noteKey, hash, lines }) {
  requireUser(userId);
  if (typeof noteKey !== 'string' || !noteKey || noteKey.length > 512) throw errValidation('noteKey is required (max 512)');
  if (typeof hash !== 'string' || !hash || hash.length > 128) throw errValidation('hash is required (max 128)');
  if (!Number.isInteger(lines) || lines < 0) throw errValidation('lines must be a non-negative integer');
  const db = getDb();
  lazyPrepare(db, `
    INSERT OR IGNORE INTO live_acks (session_id, owner_user_id, note_key, content_hash, lines)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, userId, noteKey, hash, lines);
  return getLiveAck(userId, sessionId);
}

/** Whether a finalized, not-yet-acked crash row exists for this session. */
export function hasFinalizedCrashRow(userId, sessionId) {
  requireUser(userId);
  return !!lazyPrepare(getDb(),
    'SELECT 1 FROM meetings WHERE user_id = ? AND id = ? AND meta LIKE ?',
  ).get(userId, sessionId, `%${FINALIZED_TAG}%`);
}

/** Finalized crash rows for this user (durable, survive a restart). */
export function listFinalizedCrashRows(userId) {
  requireUser(userId);
  return lazyPrepare(getDb(), `
    SELECT id, title, date, duration_sec FROM meetings
     WHERE user_id = ? AND meta LIKE ?
     ORDER BY date ASC
  `).all(userId, `%${FINALIZED_TAG}%`).map((r) => ({
    sessionId: r.id, meetingTitle: r.title, startedAt: r.date, durationSec: r.duration_sec,
  }));
}
