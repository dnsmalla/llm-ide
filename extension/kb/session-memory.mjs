// Session-scoped memory: facts extracted from ONE chat session's own turns
// (persisted alongside — but independent of — the file-based project memory
// in graphkit/memory-writer.mjs). `session_id` is an opaque client-owned
// string (the Mac app's local ChatSessionStore UUID today; see
// llm_agent/runtime/memory-persist.mjs for how it's resolved) — this module
// does no session-existence validation, since there is no session_sessions
// table to validate against (see kb/chat-sessions.mjs's header comment).
//
// Distinct from project memory by design: project memory is durable and
// edit-only (never auto-pruned), while session memory is deleted wholesale
// the moment its session is cleared or removed — see deleteSessionMemory.
import { getDb, requireUser, lazyPrepare } from './db.mjs';

/**
 * The stable per-conversation id to key session memory on — shared by the
 * write path (llm_agent/runtime/memory-persist.mjs) and the read path
 * (llm_agent/runtime/route.mjs), so they can never drift onto different keys.
 * `chatSessionId` is the client's own stable session-store UUID; plain
 * `sessionId` is re-minted on every session switch and is only a fallback for
 * a client that doesn't send the stable one.
 */
export function resolveChatSessionId(agentContext) {
  if (typeof agentContext?.chatSessionId === 'string' && agentContext.chatSessionId) {
    return agentContext.chatSessionId;
  }
  return typeof agentContext?.sessionId === 'string' ? agentContext.sessionId : undefined;
}

const FACT_MAX = 500;
const MAX_FACTS_PER_SESSION = 200; // matches config.memory-ish order of magnitude; a disk/prompt-size guard, not a product limit

function nowSec() {
  return Date.now() / 1000;
}

/** Append facts extracted from one turn, oldest-first eviction past the cap. */
export function appendSessionMemory(userId, sessionId, facts) {
  requireUser(userId);
  if (typeof sessionId !== 'string' || !sessionId) return 0;
  const clean = (Array.isArray(facts) ? facts : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .map((f) => f.trim().slice(0, FACT_MAX));
  if (clean.length === 0) return 0;

  const db = getDb();
  const ts = nowSec();
  const tx = db.transaction((uid, sid, items) => {
    const insert = lazyPrepare(db, 'INSERT INTO session_memory (user_id, session_id, fact, created_at) VALUES (?, ?, ?, ?)');
    for (const fact of items) insert.run(uid, sid, fact, ts);
    // Evict oldest-first past the cap — a runaway session must not grow
    // this table unbounded (chat_messages has its own analogous cap).
    const count = lazyPrepare(db, 'SELECT COUNT(*) AS n FROM session_memory WHERE user_id = ? AND session_id = ?').get(uid, sid).n;
    const over = count - MAX_FACTS_PER_SESSION;
    if (over > 0) {
      lazyPrepare(db, `
        DELETE FROM session_memory WHERE id IN (
          SELECT id FROM session_memory WHERE user_id = ? AND session_id = ? ORDER BY id ASC LIMIT ?
        )
      `).run(uid, sid, over);
    }
    return items.length;
  });
  return tx(userId, sessionId, clean);
}

/** Facts for one session, oldest-first (matches how they were learned). */
export function listSessionMemory(userId, sessionId) {
  requireUser(userId);
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const db = getDb();
  return lazyPrepare(db, 'SELECT fact FROM session_memory WHERE user_id = ? AND session_id = ? ORDER BY id ASC')
    .all(userId, sessionId)
    .map((r) => r.fact);
}

/** Delete every fact this session contributed. Real SQL DELETE — called when the session is cleared or removed. */
export function deleteSessionMemory(userId, sessionId) {
  requireUser(userId);
  if (typeof sessionId !== 'string' || !sessionId) return 0;
  const db = getDb();
  return lazyPrepare(db, 'DELETE FROM session_memory WHERE user_id = ? AND session_id = ?').run(userId, sessionId).changes;
}
