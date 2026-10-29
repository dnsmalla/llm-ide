// Chat lifecycle on the server (live-then-archive, plan 3.2-3.5, Phase 1 T1.3).
//
// This module is the DATABASE half: working state, the purge of server working
// state, the fenced archive of an extension chat, and the delete-everywhere
// tombstones. The SDK transcript files are deleted by the route layer
// (routes/lifecycle-routes.mjs, routes/chat.mjs), because kb/ may import only
// core/ and kb/ (eslint layer rules).
//
// Nothing calls this yet. Every helper takes userId first.
import crypto from 'node:crypto';
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { deleteAgentSession } from './agent-sessions.mjs';
import { deleteSessionMemory } from './session-memory.mjs';
import { errValidation } from '../core/errors.mjs';

export const SESSION_PURGE_REASONS = new Set(['user_delete', 'meeting_end']);
export const MAX_PURGE_IDS = 500;
export const ARCHIVE_STALE_BREAK_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();

/**
 * SHA-256 over the ordered (role, content) pairs. Each field is written as
 * `<utf8 byte length>:<value>`, so no two different message lists can produce
 * the same byte stream. The Mac app must compute the identical value
 * (schema/http/lifecycle.schema.json documents the rule).
 */
export function archiveHash(messages) {
  const h = crypto.createHash('sha256');
  for (const m of messages) {
    const role = Buffer.from(String(m.role), 'utf8');
    const content = Buffer.from(String(m.content), 'utf8');
    h.update(`${role.length}:`);
    h.update(role);
    h.update(`${content.length}:`);
    h.update(content);
  }
  return h.digest('hex');
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

/** Snapshot of an extension chat for archiving: every message, no cap (Q8). */
function readChat(db, userId, sessionId) {
  const row = lazyPrepare(db, `
    SELECT id, title, surface, mode, project_id, created_at, updated_at, lifecycle, fence
      FROM chat_sessions WHERE user_id = ? AND id = ?
  `).get(userId, sessionId);
  if (!row) return null;
  const messages = lazyPrepare(db, `
    SELECT seq, role, content, meta_json, created_at FROM chat_messages
     WHERE session_id = ? AND user_id = ? ORDER BY seq ASC
  `).all(sessionId, userId).map((m) => ({
    seq: m.seq,
    role: m.role,
    content: m.content,
    meta: m.meta_json ? safeParse(m.meta_json) : null,
    createdAt: m.created_at,
  }));
  return { row, messages };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Begin an archive: mark the chat `archiving`, bump its fence and return the
 * full snapshot with its hash. Always supersedes an earlier begin (a second
 * archive, or one abandoned by a crash, gets a new fence). Null if not found.
 */
export function archiveBegin(userId, sessionId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid) => {
    const exists = lazyPrepare(db, 'SELECT id FROM chat_sessions WHERE user_id = ? AND id = ?').get(uid, sid);
    if (!exists) return null;
    lazyPrepare(db, `
      UPDATE chat_sessions SET lifecycle = 'archiving', fence = fence + 1, archive_since = ?
       WHERE user_id = ? AND id = ?
    `).run(nowIso(), uid, sid);
    const snap = readChat(db, uid, sid);
    const fence = snap.row.fence;
    return {
      fence,
      count: snap.messages.length,
      hash: archiveHash(snap.messages),
      session: {
        id: snap.row.id,
        title: snap.row.title,
        surface: snap.row.surface,
        mode: snap.row.mode,
        projectId: snap.row.project_id,
        createdAt: snap.row.created_at,
        updatedAt: snap.row.updated_at,
      },
      messages: snap.messages,
    };
  });
  return tx(userId, sessionId);
}

/**
 * Commit an archive. The commit is accepted only when the chat is still
 * `archiving` under the presented fence AND its messages still hash to the
 * presented value (an append that raced in changes the hash).
 *   { status: 'deleted' }          rows removed now
 *   { status: 'already_archived' } the chat is gone: an earlier commit won (idempotent)
 *   { status: 'stale' }            fence or hash no longer matches: the Mac re-runs begin
 */
export function archiveCommit(userId, sessionId, { fence, hash }) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid, f, h) => {
    const row = lazyPrepare(db, 'SELECT lifecycle, fence FROM chat_sessions WHERE user_id = ? AND id = ?').get(uid, sid);
    if (!row) return { status: 'already_archived' };
    if (row.lifecycle !== 'archiving' || row.fence !== f) return { status: 'stale' };
    const snap = readChat(db, uid, sid);
    if (archiveHash(snap.messages) !== h) return { status: 'stale' };
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid);
    return { status: 'deleted', count: snap.messages.length };
  });
  return tx(userId, sessionId, fence, hash);
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
