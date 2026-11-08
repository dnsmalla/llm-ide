// Unified chat session store — per-user threads, exposed via routes/chat.mjs.
// SURFACES keeps 'mac' (migration 0023's CHECK) for rows the retired Swift app
// may have written; that app used its own local chat store, not this table.
import crypto from 'node:crypto';
import { deleteContinuation } from './chat-continuations.mjs';
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { redactSecretsForStorage } from '../core/redact-secrets.mjs';

const TITLE_MAX = 120;
const CONTENT_MAX = 64_000;
const META_MAX = 32_000;
const DEFAULT_LIST_LIMIT = 50;
const HARD_LIST_LIMIT = 200;
const DEFAULT_MSG_LIMIT = 200;
const HARD_MSG_LIMIT = 2000;
const HARD_MSGS_PER_SESSION = 2000;

const SURFACES = new Set(['mac', 'extension', 'any']);
const MODES = new Set(['ask', 'agent', 'transcript']);
const ROLES = new Set(['user', 'assistant', 'system']);

function nowSec() {
  return Date.now() / 1000;
}

// Titles are client-supplied and often derived from the first message, so a
// pasted key can land here too — same redaction as the messages.
function normTitle(raw) {
  const t = redactSecretsForStorage(String(raw || '')).trim();
  return t ? t.slice(0, TITLE_MAX) : 'New chat';
}

export function createChatSession(userId, { title, surface = 'any', mode = 'ask', projectId = null } = {}) {
  requireUser(userId);
  if (!SURFACES.has(surface)) throw new Error(`invalid surface: ${surface}`);
  if (!MODES.has(mode)) throw new Error(`invalid mode: ${mode}`);
  const id = crypto.randomUUID();
  const ts = nowSec();
  const db = getDb();
  lazyPrepare(db, `
    INSERT INTO chat_sessions (id, user_id, title, surface, mode, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, normTitle(title), surface, mode, projectId || null, ts, ts);
  return { id, title: normTitle(title), surface, mode, projectId: projectId || null, createdAt: ts, updatedAt: ts };
}

/**
 * List a user's chats, newest first. `projectId` narrows to one project; `scopedProject: true` with no
 * `projectId` narrows to the LEGACY/GLOBAL chats (project_id IS NULL), which is what a Host API client
 * that sends no project sees. Without either the list is unchanged (every chat), so the extension's
 * existing `/kb/chat/sessions` call is untouched.
 */
export function listChatSessions(userId, { surface, mode, projectId, scopedProject = false, limit, offset } = {}) {
  requireUser(userId);
  const cap = Math.min(
    Math.max(Number.isFinite(limit) ? Number(limit) : DEFAULT_LIST_LIMIT, 1),
    HARD_LIST_LIMIT,
  );
  const db = getDb();
  let sql = `
    SELECT id, title, surface, mode, project_id, created_at, updated_at
      FROM chat_sessions
     WHERE user_id = ?
  `;
  const params = [userId];
  if (surface && SURFACES.has(surface)) {
    sql += ' AND (surface = ? OR surface = ?)';
    params.push(surface, 'any');
  }
  if (mode && MODES.has(mode)) {
    sql += ' AND mode = ?';
    params.push(mode);
  }
  if (typeof projectId === 'string' && projectId) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  } else if (scopedProject) {
    sql += ' AND project_id IS NULL';
  }
  sql += ' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?';
  params.push(cap, Number.isInteger(offset) && offset > 0 ? offset : 0);
  return lazyPrepare(db, sql).all(...params).map(rowToSession);
}

function rowToSession(row) {
  return {
    id: row.id,
    title: row.title,
    surface: row.surface,
    mode: row.mode,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row) {
  let meta = null;
  if (row.meta_json) {
    try { meta = JSON.parse(row.meta_json); } catch { meta = null; }
  }
  return {
    seq: row.seq,
    role: row.role,
    content: row.content,
    meta,
    createdAt: row.created_at,
  };
}

/** True when this user has a server chat row with this id (any surface). */
export function chatSessionExists(userId, sessionId) {
  requireUser(userId);
  return !!lazyPrepare(getDb(), 'SELECT 1 FROM chat_sessions WHERE user_id = ? AND id = ?').get(userId, sessionId);
}

/**
 * One chat with its newest `messageLimit` messages (default 200, max 2000). With `beforeSeq` (an integer >= 1) the
 * page is the newest `messageLimit` messages whose seq is below it, so older history pages without re-reading the
 * newest ones. `hasMore` says whether older messages remain below the page.
 */
export function getChatSession(userId, sessionId, { messageLimit, beforeSeq } = {}) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db, `
    SELECT id, title, surface, mode, project_id, created_at, updated_at
      FROM chat_sessions
     WHERE user_id = ? AND id = ?
  `).get(userId, sessionId);
  if (!row) return null;
  const cap = Math.min(
    Math.max(Number.isFinite(messageLimit) ? Number(messageLimit) : DEFAULT_MSG_LIMIT, 1),
    HARD_MSG_LIMIT,
  );
  const before = Number.isInteger(beforeSeq) && beforeSeq >= 1 ? beforeSeq : null;
  const found = (before === null
    ? lazyPrepare(db, `
    SELECT seq, role, content, meta_json, created_at
      FROM chat_messages
     WHERE session_id = ? AND user_id = ?
     ORDER BY seq DESC
     LIMIT ?
  `).all(sessionId, userId, cap + 1)
    : lazyPrepare(db, `
    SELECT seq, role, content, meta_json, created_at
      FROM chat_messages
     WHERE session_id = ? AND user_id = ? AND seq < ?
     ORDER BY seq DESC
     LIMIT ?
  `).all(sessionId, userId, before, cap + 1));
  const hasMore = found.length > cap;
  const msgRows = hasMore ? found.slice(0, cap) : found;
  return {
    ...rowToSession(row),
    messages: msgRows.reverse().map(rowToMessage),
    hasMore,
  };
}

export function updateChatSession(userId, sessionId, { title } = {}) {
  requireUser(userId);
  const db = getDb();
  const ts = nowSec();
  const changes = lazyPrepare(db, `
    UPDATE chat_sessions
       SET title = ?, updated_at = ?
     WHERE user_id = ? AND id = ?
  `).run(normTitle(title), ts, userId, sessionId).changes;
  return changes > 0;
}

export function deleteChatSession(userId, sessionId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid) => {
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    deleteContinuation(uid, sid);
    return lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid).changes;
  });
  return tx(userId, sessionId) > 0;
}

export function clearChatMessages(userId, sessionId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid) => {
    const n = lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid).changes;
    deleteContinuation(uid, sid);
    lazyPrepare(db, 'UPDATE chat_sessions SET updated_at = ? WHERE user_id = ? AND id = ?').run(nowSec(), uid, sid);
    return n;
  });
  return tx(userId, sessionId);
}

/**
 * True when a stored row's meta marks it as a reply the stream cut off mid-way (the client writes
 * `{ interrupted: true, status: 'interrupted' }`; older writers may set only one of them).
 */
function isInterruptedMeta(metaJson) {
  if (!metaJson) return false;
  try {
    const meta = JSON.parse(metaJson);
    return meta?.interrupted === true || meta?.status === 'interrupted';
  } catch {
    return false;
  }
}

/**
 * Drops the NEWEST interrupted assistant reply from a chat's history (U#F5): a retry replaces the partial
 * with the full answer, so the partial must not come back on a reload. Scoped by `userId` AND `sessionId` AND
 * `seq`, so another user's row (or another chat's) can never match; only a row whose stored meta says it was
 * interrupted can be dropped — a complete reply is refused — and only when it is the session's `MAX(seq)`,
 * matching the desktop store's `drop_interrupted` (an older partial the user kept is history, not a retry).
 *
 * Hard delete, not a marker/tombstone: `chat_messages` has no soft-delete column, and every reader (history
 * paging, the archive hash/fence, the pre-archive count) would have to learn to filter a tombstone — a much
 * larger surface than the one partial this is allowed to remove. The partial is not history the user keeps:
 * the retry's full reply replaces it. Idempotent: an already-gone row answers `already_gone` (the route 200s),
 * while a session this user does not own answers `not_found` (the route 404s).
 *
 * Returns { status: 'deleted' | 'already_gone' | 'not_interrupted' | 'not_latest' | 'not_found', seq }.
 */
export function deleteChatMessage(userId, sessionId, seq) {
  requireUser(userId);
  if (!Number.isInteger(seq) || seq < 1) throw new Error('seq must be an integer >= 1');
  const db = getDb();
  const tx = db.transaction((uid, sid, n) => {
    const owned = lazyPrepare(db, 'SELECT id FROM chat_sessions WHERE user_id = ? AND id = ?').get(uid, sid);
    if (!owned) return { status: 'not_found', seq: n };
    const row = lazyPrepare(db, `
      SELECT role, meta_json FROM chat_messages
       WHERE session_id = ? AND user_id = ? AND seq = ?
    `).get(sid, uid, n);
    if (!row) return { status: 'already_gone', seq: n };
    if (row.role !== 'assistant' || !isInterruptedMeta(row.meta_json)) {
      return { status: 'not_interrupted', seq: n };
    }
    // The desktop store only ever pops its newest row; the core route must agree, or it could drop an
    // older interrupted partial the user deliberately kept. Checked after `already_gone` so a repeat of
    // the drop that succeeded stays idempotent (MAX(seq) has moved down since).
    const newest = lazyPrepare(db, `
      SELECT MAX(seq) AS seq FROM chat_messages WHERE session_id = ? AND user_id = ?
    `).get(sid, uid)?.seq;
    if (newest !== n) return { status: 'not_latest', seq: n };
    const changes = lazyPrepare(db, `
      DELETE FROM chat_messages WHERE session_id = ? AND user_id = ? AND seq = ?
    `).run(sid, uid, n).changes;
    // The chat's `updated_at` is intentionally untouched: dropping a partial is a repair of the turn that just
    // failed, not new activity, and it must not reorder the chat list. `seq` is not reused either (the append path
    // takes MAX(seq)+1), so an older page cursor still means what it meant.
    return { status: changes > 0 ? 'deleted' : 'already_gone', seq: n };
  });
  return tx(userId, sessionId, seq);
}

export function appendChatMessage(userId, sessionId, { role, content, meta = null }) {
  requireUser(userId);
  if (!ROLES.has(role)) throw new Error(`invalid role: ${role}`);
  // Stored transcripts come back as chat history and search hits, so a key a
  // user pastes ("configure it with sk-ant-…") must not be persisted as-is.
  // Redacted at the write, not the route, so every caller is covered. The
  // marker contains no quote characters, so redacting inside meta JSON keeps
  // it parseable.
  const rawContent = String(content || '');
  const text = redactSecretsForStorage(rawContent.slice(0, CONTENT_MAX));
  if (!text) throw new Error('content is required');
  // Anything the store cannot keep is COUNTED, so an archive of this chat can say
  // it is incomplete (plan 3.3, DL12) instead of silently losing the rest.
  let truncated = rawContent.length > CONTENT_MAX ? 1 : 0;
  let metaJson = null;
  if (meta != null) {
    const fullMeta = JSON.stringify(meta);
    if (fullMeta.length > META_MAX) truncated += 1;
    metaJson = redactSecretsForStorage(fullMeta.slice(0, META_MAX));
  }
  const db = getDb();
  const tx = db.transaction((uid, sid, r, c, m) => {
    const owned = lazyPrepare(db, 'SELECT id FROM chat_sessions WHERE user_id = ? AND id = ?').get(uid, sid);
    if (!owned) throw new Error('session not found');

    const nextSeq = lazyPrepare(db,
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_messages WHERE session_id = ?',
    ).get(sid)?.next ?? 1;
    const ts = nowSec();
    lazyPrepare(db, `
      INSERT INTO chat_messages (session_id, user_id, seq, role, content, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sid, uid, nextSeq, r, c, m, ts);
    lazyPrepare(db, 'UPDATE chat_sessions SET updated_at = ? WHERE user_id = ? AND id = ?').run(ts, uid, sid);

    // Prune oldest messages beyond HARD_MSGS_PER_SESSION (counted, see above)
    const pruned = lazyPrepare(db, `
      DELETE FROM chat_messages
       WHERE session_id = ?
         AND seq < (
           SELECT seq FROM chat_messages
            WHERE session_id = ?
            ORDER BY seq DESC
            LIMIT 1 OFFSET ?
         )
    `).run(sid, sid, HARD_MSGS_PER_SESSION - 1).changes;
    if (pruned > 0 || truncated > 0) {
      lazyPrepare(db, `UPDATE chat_sessions SET pruned_messages = pruned_messages + ?,
        truncated_messages = truncated_messages + ? WHERE user_id = ? AND id = ?`)
        .run(pruned, truncated, uid, sid);
    }

    return { seq: nextSeq, createdAt: ts };
  });
  return tx(userId, sessionId, role, text, metaJson);
}
