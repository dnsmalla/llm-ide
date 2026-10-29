// Durable finalized extension captures and their acks (live-then-archive plan
// 3.6 B, Phase 1). A finalized capture is kept as a live_crash_rows row until the
// Mac app acks it; the ack is accepted only when the server can reproduce the
// capture's line count and content hash (agents/live-sessions.mjs decides, this
// module stores). The ack row holds ids and hashes only.
//
// Bounds (see the constants): per user, a maximum number of unacked captures and
// of bytes, a 7-day expiry, and 90-day retention of ack rows. Every helper takes
// the owning userId, except the system jobs (expireCrashRows, pruneLiveAcks)
// which run over all rows and are not wired to a timer yet.
import crypto from 'node:crypto';
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { checkNoteKey } from './note-index.mjs';
import { errValidation } from '../core/errors.mjs';

export const UNACKED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_UNACKED_PER_USER = 200;
export const MAX_UNACKED_BYTES_PER_USER = 64 * 1024 * 1024;
export const ACK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
export const transcriptHash = sha256;
export const noteKeyHash = (key) => sha256(key);
const iso = (ms) => new Date(ms).toISOString();

export function getLiveAck(userId, sessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(), `
    SELECT session_id, note_key_hash, content_hash, lines, outcome, acked_at, caption_hash, language, started_at
      FROM live_acks WHERE owner_user_id = ? AND session_id = ?
  `).get(userId, sessionId) ?? null;
}

/** A new capture under this id supersedes any earlier ack for it. */
export function deleteLiveAck(userId, sessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(), 'DELETE FROM live_acks WHERE owner_user_id = ? AND session_id = ?')
    .run(userId, sessionId).changes;
}

export function getCrashRow(userId, sessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(), `
    SELECT session_id, title, started_at, duration_sec, transcript, lines, content_hash, bytes, expires_at, caption_hash, language
      FROM live_crash_rows WHERE owner_user_id = ? AND session_id = ?
  `).get(userId, sessionId) ?? null;
}

export function unackedUsage(userId, { excludeSession = null } = {}) {
  requireUser(userId);
  const row = lazyPrepare(getDb(), `
    SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM live_crash_rows
     WHERE owner_user_id = ? AND (? IS NULL OR session_id <> ?)
  `).get(userId, excludeSession, excludeSession);
  return { count: row.n, bytes: row.b };
}

/**
 * Store (or replace, on a re-finalize) the durable copy of a finalized capture.
 * Returns { durable: true, expiresAt } or, when the user is at a bound,
 * { durable: false, reason: 'UNACKED_LIMIT' } and writes nothing.
 */
export function putCrashRow(userId, sessionId, capture, {
  maxSessions = MAX_UNACKED_PER_USER, maxBytes = MAX_UNACKED_BYTES_PER_USER, now = Date.now(),
} = {}) {
  requireUser(userId);
  const { title, startedAt, durationSec = 0, transcript, lines, captionHash = '', language = '' } = capture;
  if (typeof transcript !== 'string' || !Number.isInteger(lines) || lines < 0) {
    throw errValidation('capture needs a transcript string and a line count');
  }
  const bytes = Buffer.byteLength(transcript, 'utf8');
  const usage = unackedUsage(userId, { excludeSession: sessionId });
  if (usage.count + 1 > maxSessions || usage.bytes + bytes > maxBytes) {
    return { durable: false, reason: 'UNACKED_LIMIT' };
  }
  const expiresAt = iso(now + UNACKED_TTL_MS);
  lazyPrepare(getDb(), `
    INSERT OR REPLACE INTO live_crash_rows
      (session_id, owner_user_id, title, started_at, duration_sec, transcript, lines,
       content_hash, bytes, finalized_at, expires_at, caption_hash, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, userId, String(title || 'Meeting').slice(0, 300), String(startedAt),
    Math.max(0, Math.round(durationSec)), transcript, lines, transcriptHash(transcript), bytes,
    iso(now), expiresAt, String(captionHash), String(language).slice(0, 35));
  return { durable: true, expiresAt };
}

/** Unacked durable captures of this user, newest first. */
export function listCrashRows(userId) {
  requireUser(userId);
  return lazyPrepare(getDb(), `
    SELECT session_id, title, started_at, duration_sec, lines, content_hash, expires_at, language
      FROM live_crash_rows r
     WHERE owner_user_id = ?
       AND NOT EXISTS (SELECT 1 FROM live_acks a WHERE a.owner_user_id = r.owner_user_id AND a.session_id = r.session_id)
     ORDER BY finalized_at DESC
  `).all(userId);
}

/**
 * Record the ack and delete the durable copy in ONE transaction. If either step
 * fails, neither happens: the capture stays unacked and nothing is lost.
 */
export function ackCapture(userId, sessionId, { noteKey, hash, lines, captionHash = '', language = '', startedAt = '', now = Date.now() }) {
  requireUser(userId);
  const key = checkNoteKey(noteKey);
  const db = getDb();
  const tx = db.transaction(() => {
    lazyPrepare(db, `
      INSERT INTO live_acks (session_id, owner_user_id, note_key_hash, content_hash, lines, outcome, acked_at,
                             caption_hash, language, started_at)
      VALUES (?, ?, ?, ?, ?, 'acked', ?, ?, ?, ?)
    `).run(sessionId, userId, noteKeyHash(key), hash, lines, iso(now), String(captionHash), String(language), String(startedAt));
    lazyPrepare(db, 'DELETE FROM live_crash_rows WHERE owner_user_id = ? AND session_id = ?').run(userId, sessionId);
  });
  tx();
  return getLiveAck(userId, sessionId);
}

/**
 * Expire one unacked capture: its durable copy goes, and an 'expired' ack row
 * records that it went (so status answers 'expired', not 'unknown').
 */
export function expireCrashRow(userId, sessionId, { now = Date.now() } = {}) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction(() => {
    lazyPrepare(db, `
      INSERT OR REPLACE INTO live_acks (session_id, owner_user_id, note_key_hash, content_hash, lines, outcome, acked_at)
      VALUES (?, ?, '', '', 0, 'expired', ?)
    `).run(sessionId, userId, iso(now));
    lazyPrepare(db, 'DELETE FROM live_crash_rows WHERE owner_user_id = ? AND session_id = ?').run(userId, sessionId);
  });
  tx();
}

/**
 * System job (not wired): expire every durable capture past its TTL. Loud on
 * purpose: each expiry is logged, because it means unacked data was dropped.
 */
export function expireCrashRows({ now = Date.now(), log = console.error } = {}) {
  const due = lazyPrepare(getDb(),
    'SELECT owner_user_id, session_id, title, lines FROM live_crash_rows WHERE expires_at <= ?',
  ).all(iso(now));
  for (const r of due) {
    expireCrashRow(r.owner_user_id, r.session_id, { now });
    log(`[live] EXPIRED unacked capture ${r.session_id} (${r.lines} lines, "${r.title}") after 7 days; it was never acked by the Mac`);
  }
  return due.map((r) => ({ userId: r.owner_user_id, sessionId: r.session_id }));
}

/** System job (not wired): drop ack rows older than the retention window (90 days). */
export function pruneLiveAcks({ now = Date.now(), retentionMs = ACK_RETENTION_MS } = {}) {
  return lazyPrepare(getDb(), 'DELETE FROM live_acks WHERE acked_at < ?').run(iso(now - retentionMs)).changes;
}

/** Ack rows for one session are removed with its meeting (kb/meetings.mjs deleteMeeting). */
export function deleteAcksForSession(userId, sessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(), 'DELETE FROM live_acks WHERE owner_user_id = ? AND session_id = ?')
    .run(userId, sessionId).changes;
}
