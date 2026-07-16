// Unified chat session store — per-user threads shared by mac + extension.
import crypto from 'node:crypto';
import { getDb, requireUser, lazyPrepare } from './db.mjs';

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

function normTitle(raw) {
  const t = String(raw || '').trim();
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

export function listChatSessions(userId, { surface, mode, limit } = {}) {
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
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(cap);
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

export function getChatSession(userId, sessionId, { messageLimit } = {}) {
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
  const msgRows = lazyPrepare(db, `
    SELECT seq, role, content, meta_json, created_at
      FROM chat_messages
     WHERE session_id = ? AND user_id = ?
     ORDER BY seq DESC
     LIMIT ?
  `).all(sessionId, userId, cap);
  return {
    ...rowToSession(row),
    messages: msgRows.reverse().map(rowToMessage),
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
    return lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid).changes;
  });
  return tx(userId, sessionId) > 0;
}

export function clearChatMessages(userId, sessionId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction((uid, sid) => {
    const n = lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid).changes;
    lazyPrepare(db, 'UPDATE chat_sessions SET updated_at = ? WHERE user_id = ? AND id = ?').run(nowSec(), uid, sid);
    return n;
  });
  return tx(userId, sessionId);
}

export function appendChatMessage(userId, sessionId, { role, content, meta = null }) {
  requireUser(userId);
  if (!ROLES.has(role)) throw new Error(`invalid role: ${role}`);
  const text = String(content || '').slice(0, CONTENT_MAX);
  if (!text) throw new Error('content is required');
  let metaJson = null;
  if (meta != null) {
    metaJson = JSON.stringify(meta).slice(0, META_MAX);
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

    // Prune oldest messages beyond HARD_MSGS_PER_SESSION
    lazyPrepare(db, `
      DELETE FROM chat_messages
       WHERE session_id = ?
         AND seq < (
           SELECT seq FROM chat_messages
            WHERE session_id = ?
            ORDER BY seq DESC
            LIMIT 1 OFFSET ?
         )
    `).run(sid, sid, HARD_MSGS_PER_SESSION - 1);

    return { seq: nextSeq, createdAt: ts };
  });
  return tx(userId, sessionId, role, text, metaJson);
}
