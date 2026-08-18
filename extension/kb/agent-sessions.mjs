// Agent v2 engine session mapping (migration 0029): binds a Mac ChatSession
// UUID (`mac_chat_session_id` — the client-owned stable id, same notion as
// kb/session-memory.mjs's resolveChatSessionId) to the Claude Agent SDK
// session id so consecutive turns resume the same server-side SDK
// conversation instead of starting cold.
//
// Unlike the sibling kb modules, every helper here takes `db` explicitly as
// the first argument — the v2 engine holds its own connection handle and
// calls these from llm_agent/sdk/… verbatim. `userId` is always second
// (repo invariant); every statement is scoped WHERE user_id = ?.
import crypto from 'node:crypto';
import { requireUser, lazyPrepare } from './db.mjs';

// `chat_scope` distinguishes which surface owns the mapping (explorer vs
// future scopes). Single default today — no Set to validate against (YAGNI).
const DEFAULT_SCOPE = 'explorer';
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function requireChatSessionId(chatSessionId) {
  if (typeof chatSessionId !== 'string' || !chatSessionId) {
    throw new Error('chatSessionId is required for agent-session operations');
  }
  return chatSessionId;
}

function rowToSession(row) {
  return {
    id: row.id,
    sdk_session_id: row.sdk_session_id,
    model: row.model,
    last_mode: row.last_mode,
  };
}

/**
 * Fetch the mapping for (userId, chatSessionId), creating it on first use.
 * A fresh mapping has sdk_session_id NULL — the engine mints the SDK session
 * on turn 1 and records it via markAgentSessionUsed.
 */
export function getOrCreateAgentSession(db, userId, chatSessionId, chatScope) {
  requireUser(userId);
  requireChatSessionId(chatSessionId);
  const scope = typeof chatScope === 'string' && chatScope ? chatScope : DEFAULT_SCOPE;
  const tx = db.transaction((uid, chatId, chatScopeValue) => {
    const existing = lazyPrepare(db, `
      SELECT id, sdk_session_id, model, last_mode
        FROM agent_sessions
       WHERE user_id = ? AND mac_chat_session_id = ?
    `).get(uid, chatId);
    if (existing) return rowToSession(existing);
    const id = crypto.randomUUID();
    lazyPrepare(db, `
      INSERT INTO agent_sessions (id, user_id, chat_scope, mac_chat_session_id)
      VALUES (?, ?, ?, ?)
    `).run(id, uid, chatScopeValue, chatId);
    return { id, sdk_session_id: null, model: null, last_mode: null };
  });
  return tx(userId, chatSessionId, scope);
}

/**
 * Record that a turn ran against `sdkSessionId` — upserts the sdk id on the
 * first turn (row may not exist yet if the caller skipped getOrCreate) and
 * refreshes model/mode/last_used_at on every turn.
 */
export function markAgentSessionUsed(db, userId, chatSessionId, { sdkSessionId, model, mode } = {}) {
  requireUser(userId);
  requireChatSessionId(chatSessionId);
  const tx = db.transaction((uid, chatId, sdk, mdl, mde) => {
    const updated = lazyPrepare(db, `
      UPDATE agent_sessions
         SET sdk_session_id = ?, model = ?, last_mode = ?, last_used_at = ${NOW_SQL}
       WHERE user_id = ? AND mac_chat_session_id = ?
    `).run(sdk, mdl, mde, uid, chatId);
    if (updated.changes > 0) return;
    lazyPrepare(db, `
      INSERT INTO agent_sessions (id, user_id, chat_scope, mac_chat_session_id, sdk_session_id, model, last_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), uid, DEFAULT_SCOPE, chatId, sdk, mdl, mde);
  });
  tx(userId, chatSessionId, sdkSessionId ?? null, model ?? null, mode ?? null);
}

/**
 * Drop the SDK binding for a fresh start (e.g. the SDK session became
 * unresumable) while keeping the mapping row and its scope.
 */
export function replaceAgentSession(db, userId, chatSessionId) {
  requireUser(userId);
  requireChatSessionId(chatSessionId);
  lazyPrepare(db, `
    UPDATE agent_sessions
       SET sdk_session_id = NULL, last_used_at = ${NOW_SQL}
     WHERE user_id = ? AND mac_chat_session_id = ?
  `).run(userId, chatSessionId);
}

/**
 * Delete the mapping, returning the row's `sdkSessionId` (or null when it
 * had none / never existed) so the caller can clean up transcripts.
 */
export function deleteAgentSession(db, userId, chatSessionId) {
  requireUser(userId);
  requireChatSessionId(chatSessionId);
  const tx = db.transaction((uid, chatId) => {
    const row = lazyPrepare(db, `
      SELECT sdk_session_id
        FROM agent_sessions
       WHERE user_id = ? AND mac_chat_session_id = ?
    `).get(uid, chatId);
    if (!row) return null;
    lazyPrepare(db, 'DELETE FROM agent_sessions WHERE user_id = ? AND mac_chat_session_id = ?')
      .run(uid, chatId);
    return { sdkSessionId: row.sdk_session_id };
  });
  return tx(userId, chatSessionId);
}
