// The typed ledger beside project memory's markdown store — see migration
// 0038 for why the content stays in chat-memory.md. Every write is
// best-effort for its CALLER (memory-persist swallows a throw): the ledger
// refines ranking and provenance, it never gates capturing a fact.

import { getDb, requireUser } from './db.mjs';
import { factIndex } from '../core/fact-key.mjs';

const MAX_SESSION_CHARS = 128;

function categoryOf(fact) {
  const tag = /^\s*\[([^\]|]+)(?:\|[^\]]*)?\]/.exec(String(fact));
  return tag ? tag[1].trim().toLowerCase().slice(0, 64) : null;
}

/**
 * Record one turn's outcome for the repo at `repoRoot`:
 *   `confirmed` — every fact the turn extracted (new, updated or restated)
 *   `removed`   — facts the turn retired (superseded)
 * Same-index facts collapse to one row; a confirmation revives a superseded one.
 */
export function recordMemoryLedger(userId, repoRoot, { confirmed = [], removed = [], chatSessionId = null } = {}) {
  requireUser(userId);
  if (typeof repoRoot !== 'string' || !repoRoot) return;
  const db = getDb();
  const session = typeof chatSessionId === 'string' && chatSessionId ? chatSessionId.slice(0, MAX_SESSION_CHARS) : null;
  const confirm = db.prepare(`
    INSERT INTO project_memory_ledger (user_id, repo_root, fact_index, category, source_chat_session, last_chat_session)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, repo_root, fact_index) DO UPDATE SET
      confirmations = confirmations + 1,
      last_confirmed_at = datetime('now'),
      last_chat_session = COALESCE(excluded.last_chat_session, last_chat_session),
      category = COALESCE(excluded.category, category),
      status = 'active'`);
  const retire = db.prepare(`UPDATE project_memory_ledger SET status = 'superseded'
    WHERE user_id = ? AND repo_root = ? AND fact_index = ?`);
  db.transaction(() => {
    const seen = new Set();
    for (const fact of confirmed) {
      const key = factIndex(fact);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      confirm.run(userId, repoRoot, key, categoryOf(fact), session, session);
    }
    for (const fact of removed) {
      const key = factIndex(fact);
      if (key) retire.run(userId, repoRoot, key);
    }
  })();
}

/** fact_index → { category, firstSeenAt, lastConfirmedAt, confirmations, sourceChatSession, lastChatSession, status } */
export function memoryLedgerFor(userId, repoRoot) {
  requireUser(userId);
  const rows = getDb().prepare(`SELECT fact_index, category, first_seen_at, last_confirmed_at, confirmations,
      source_chat_session, last_chat_session, status
    FROM project_memory_ledger WHERE user_id = ? AND repo_root = ?`).all(userId, String(repoRoot));
  return new Map(rows.map((r) => [r.fact_index, {
    category: r.category,
    firstSeenAt: r.first_seen_at,
    lastConfirmedAt: r.last_confirmed_at,
    confirmations: r.confirmations,
    sourceChatSession: r.source_chat_session,
    lastChatSession: r.last_chat_session,
    status: r.status,
  }]));
}
