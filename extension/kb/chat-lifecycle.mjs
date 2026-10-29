// Chat lifecycle on the server (live-then-archive, plan 3.2-3.5, Phase 1 T1.3).
//
// This module is the DATABASE half: working state, the purge of server working
// state, the fenced archive of an extension chat, receipts, and the
// delete-everywhere tombstones. The SDK transcript files are deleted by the
// route layer (routes/lifecycle-routes.mjs, routes/chat.mjs), because kb/ may
// import only core/ and kb/ (eslint layer rules).
//
// Nothing calls this yet. Every helper takes userId first.
import crypto from 'node:crypto';
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { deleteAgentSession } from './agent-sessions.mjs';
import { deleteSessionMemory } from './session-memory.mjs';
import { errValidation } from '../core/errors.mjs';

export const SESSION_PURGE_REASONS = new Set(['user_delete', 'meeting_end']);
export const MAX_PURGE_IDS = 500;
export const ARCHIVE_PAGE_DEFAULT = 200;
export const ARCHIVE_PAGE_MAX = 500;
export const ARCHIVE_PAGE_BYTES = 8 * 1024 * 1024;

const nowIso = () => new Date().toISOString();

function feedMessage(h, role, content) {
  const r = Buffer.from(String(role), 'utf8');
  const c = Buffer.from(String(content), 'utf8');
  h.update(`${r.length}:`);
  h.update(r);
  h.update(`${c.length}:`);
  h.update(c);
}

/**
 * SHA-256 over the ordered (role, content) pairs, each field written as
 * `<utf8 byte length>:<value>`, so no two different message lists produce the
 * same byte stream. The Mac app computes the identical value over the messages
 * in the file it wrote (schema/http/lifecycle.schema.json documents the rule).
 * An empty list hashes to the SHA-256 of the empty string.
 */
export function archiveHash(messages) {
  const h = crypto.createHash('sha256');
  for (const m of messages) feedMessage(h, m.role, m.content);
  return h.digest('hex');
}

/**
 * The same digest as archiveHash, computed by streaming the chat's rows in
 * order, so a chat of any length is hashed without loading it whole.
 */
export function archiveDigest(db, userId, sessionId) {
  const h = crypto.createHash('sha256');
  let count = 0;
  const stmt = lazyPrepare(db, `
    SELECT role, content FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY seq ASC
  `);
  for (const row of stmt.iterate(sessionId, userId)) {
    feedMessage(h, row.role, row.content);
    count += 1;
  }
  return { hash: h.digest('hex'), count };
}

/**
 * Chats that still hold server working state for this user: an agent session
 * mapping (the SDK session id and its timestamp) and/or session-memory facts.
 */
export function listWorkingState(userId) {
  requireUser(userId);
  const db = getDb();
  const byId = new Map();
  for (const r of lazyPrepare(db, `
    SELECT mac_chat_session_id AS id, sdk_session_id, last_used_at
      FROM agent_sessions WHERE user_id = ?
  `).all(userId)) {
    byId.set(r.id, { chatSessionId: r.id, sdkSession: r.sdk_session_id ?? null, factCount: 0, updatedAt: r.last_used_at });
  }
  for (const r of lazyPrepare(db, `
    SELECT session_id AS id, COUNT(*) AS n FROM session_memory WHERE user_id = ? GROUP BY session_id
  `).all(userId)) {
    const row = byId.get(r.id) ?? { chatSessionId: r.id, sdkSession: null, factCount: 0, updatedAt: null };
    row.factCount = r.n;
    byId.set(r.id, row);
  }
  return { sessions: [...byId.values()] };
}

/**
 * Remove the server working state of the given chats (mapping + memory) in one
 * transaction. Idempotent: unknown ids are a no-op. Returns the SDK session ids
 * whose transcripts the caller must delete.
 */
export function purgeWorkingState(userId, chatSessionIds) {
  requireUser(userId);
  if (!Array.isArray(chatSessionIds) || chatSessionIds.length > MAX_PURGE_IDS
    || chatSessionIds.some((id) => typeof id !== 'string' || !id)) {
    throw errValidation(`chatSessionIds must be up to ${MAX_PURGE_IDS} non-empty strings`);
  }
  const db = getDb();
  const sdkSessionIds = [];
  let purged = 0;
  const tx = db.transaction((ids) => {
    for (const id of ids) {
      const dropped = deleteAgentSession(db, userId, id);
      if (dropped?.sdkSessionId) sdkSessionIds.push(dropped.sdkSessionId);
      const hadFacts = deleteSessionMemory(userId, id) > 0;
      if (dropped || hadFacts) purged += 1;
    }
  });
  tx(chatSessionIds);
  return { purged, sdkSessionIds };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function sessionRow(db, userId, sessionId) {
  return lazyPrepare(db, `
    SELECT id, title, surface, mode, project_id, created_at, updated_at, lifecycle, fence,
           pruned_messages, truncated_messages
      FROM chat_sessions WHERE user_id = ? AND id = ?
  `).get(userId, sessionId);
}

/** One page of messages after `after` (seq), bounded by count and by bytes. */
function messagePage(db, userId, sessionId, after, limit) {
  const want = Math.min(Math.max(Number.isFinite(limit) ? limit : ARCHIVE_PAGE_DEFAULT, 1), ARCHIVE_PAGE_MAX);
  const rows = lazyPrepare(db, `
    SELECT seq, role, content, meta_json, created_at FROM chat_messages
     WHERE session_id = ? AND user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
  `).all(sessionId, userId, after, want + 1);
  const out = [];
  let bytes = 0;
  let more = rows.length > want;
  for (const m of rows.slice(0, want)) {
    const size = Buffer.byteLength(m.content, 'utf8');
    if (out.length > 0 && bytes + size > ARCHIVE_PAGE_BYTES) { more = true; break; }
    bytes += size;
    out.push({
      seq: m.seq,
      role: m.role,
      content: m.content,
      meta: m.meta_json ? safeParse(m.meta_json) : null,
      createdAt: m.created_at,
    });
  }
  return { messages: out, nextAfter: more && out.length > 0 ? out[out.length - 1].seq : null };
}

function snapshotEnvelope(row, digest, page) {
  return {
    fence: row.fence,
    count: digest.count,
    hash: digest.hash,
    incomplete: {
      incomplete: row.pruned_messages > 0 || row.truncated_messages > 0,
      prunedMessages: row.pruned_messages,
      truncatedMessages: row.truncated_messages,
    },
    session: {
      id: row.id,
      title: row.title,
      surface: row.surface,
      mode: row.mode,
      projectId: row.project_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    messages: page.messages,
    nextAfter: page.nextAfter,
  };
}

/**
 * Archive begin, paged. Without `after`: marks the chat `archiving`, bumps its
 * fence and returns the first page with the digest of ALL messages. With `after`
 * (a continuation page): requires the fence of the initial begin, does not bump
 * it, and returns the next page. Returns null when the chat is not found and
 * { stale: true } when the fence does not match.
 */
export function archiveBegin(userId, sessionId, { after, limit, fence } = {}) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid) => {
    const row0 = sessionRow(db, uid, sid);
    if (!row0) return null;
    if (after === undefined) {
      lazyPrepare(db, `
        UPDATE chat_sessions SET lifecycle = 'archiving', fence = fence + 1, archive_since = ?
         WHERE user_id = ? AND id = ?
      `).run(nowIso(), uid, sid);
    } else if (row0.lifecycle !== 'archiving' || row0.fence !== fence) {
      return { stale: true };
    }
    const row = sessionRow(db, uid, sid);
    const digest = archiveDigest(db, uid, sid);
    const page = messagePage(db, uid, sid, after ?? 0, limit);
    return snapshotEnvelope(row, digest, page);
  });
  return tx(userId, sessionId);
}

/** The receipt a server commit or a Mac-verified file left for this chat, or null. */
export function getArchiveReceipt(userId, chatSessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(),
    'SELECT hash, message_count, source, committed_at FROM archive_receipts WHERE owner_user_id = ? AND chat_session_id = ?',
  ).get(userId, chatSessionId) ?? null;
}

export function hasArchiveReceipt(userId, chatSessionId) {
  return getArchiveReceipt(userId, chatSessionId) !== null;
}

/**
 * The Mac app's own verification of the file it wrote (plan 3.3 step 3): the
 * client sends the hash and count it computed from the file. Recorded as a
 * receipt with source 'mac-file'. The server cannot read the Mac file, so this
 * is the client's assertion; the purge it enables only touches derivative state.
 */
export function recordMacArchiveReceipt(userId, chatSessionId, { hash, count }) {
  requireUser(userId);
  if (typeof chatSessionId !== 'string' || !chatSessionId) throw errValidation('chatSessionId is required');
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw errValidation('hash must be 64 lower-case hex characters');
  if (!Number.isInteger(count) || count < 0) throw errValidation('count must be a non-negative integer');
  lazyPrepare(getDb(), `
    INSERT OR REPLACE INTO archive_receipts (owner_user_id, chat_session_id, hash, message_count, source, committed_at)
    VALUES (?, ?, ?, ?, 'mac-file', ?)
  `).run(userId, chatSessionId, hash, count, nowIso());
  return getArchiveReceipt(userId, chatSessionId);
}

/**
 * Commit an archive. Accepted only when the chat is still `archiving` under the
 * presented fence AND its messages hash to the presented value (the Mac's own
 * recompute over the file it wrote). Outcomes:
 *   { status: 'deleted', count }     rows removed now, a 'commit' receipt written
 *   { status: 'already_archived' }   the chat is gone AND a receipt with this hash exists
 *   { status: 'not_found' }          the chat is gone and no matching receipt: 404
 *   { status: 'stale' }              fence or hash does not match: begin again (409)
 *   { status: 'incomplete', ... }    the chat lost messages to the caps and the client
 *                                    did not pass acceptIncomplete (409)
 */
export function archiveCommit(userId, sessionId, { fence, hash, acceptIncomplete = false }) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid, f, h, accept) => {
    const row = sessionRow(db, uid, sid);
    if (!row) {
      const rec = getArchiveReceipt(uid, sid);
      return rec && rec.hash === h ? { status: 'already_archived' } : { status: 'not_found' };
    }
    if (row.lifecycle !== 'archiving' || row.fence !== f) return { status: 'stale' };
    const incomplete = row.pruned_messages > 0 || row.truncated_messages > 0;
    if (incomplete && accept !== true) {
      return { status: 'incomplete', prunedMessages: row.pruned_messages, truncatedMessages: row.truncated_messages };
    }
    const digest = archiveDigest(db, uid, sid);
    if (digest.hash !== h) return { status: 'stale' };
    lazyPrepare(db, `
      INSERT OR REPLACE INTO archive_receipts (owner_user_id, chat_session_id, hash, message_count, source, committed_at)
      VALUES (?, ?, ?, ?, 'commit', ?)
    `).run(uid, sid, h, digest.count, nowIso());
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid);
    return { status: 'deleted', count: digest.count };
  });
  return tx(userId, sessionId, fence, hash, acceptIncomplete);
}

/**
 * Record a delete-everywhere tombstone. Re-queuing the same chat refreshes the
 * request time (the replay compares it with the chat's last use).
 */
export function enqueueSessionPurge(userId, chatSessionId, reason = 'user_delete') {
  requireUser(userId);
  if (typeof chatSessionId !== 'string' || !chatSessionId) throw errValidation('chatSessionId is required');
  if (!SESSION_PURGE_REASONS.has(reason)) throw errValidation(`reason must be one of ${[...SESSION_PURGE_REASONS].join(', ')}`);
  lazyPrepare(getDb(), `
    INSERT INTO pending_session_purges (deleted_chat_id, owner_user_id, reason, attempts, requested_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (deleted_chat_id, owner_user_id) DO UPDATE SET
      reason = excluded.reason, requested_at = excluded.requested_at
  `).run(chatSessionId, userId, reason, nowIso());
}

/** Tombstones this user still owes, with the chat's last use for the reuse check (DL16). */
export function listSessionPurges(userId) {
  requireUser(userId);
  return lazyPrepare(getDb(), `
    SELECT p.deleted_chat_id AS chatSessionId, p.reason, p.attempts, p.requested_at AS requestedAt,
           (SELECT MAX(a.last_used_at) FROM agent_sessions a
             WHERE a.user_id = p.owner_user_id AND a.mac_chat_session_id = p.deleted_chat_id) AS lastUsedAt
      FROM pending_session_purges p WHERE p.owner_user_id = ?
     ORDER BY p.requested_at
  `).all(userId);
}

export function completeSessionPurge(userId, chatSessionId) {
  requireUser(userId);
  return lazyPrepare(getDb(),
    'DELETE FROM pending_session_purges WHERE owner_user_id = ? AND deleted_chat_id = ?',
  ).run(userId, chatSessionId).changes > 0;
}

export function failSessionPurge(userId, chatSessionId) {
  requireUser(userId);
  lazyPrepare(getDb(),
    'UPDATE pending_session_purges SET attempts = attempts + 1 WHERE owner_user_id = ? AND deleted_chat_id = ?',
  ).run(userId, chatSessionId);
}
