//
// Per-(user, tool) "always allow" persistence for act-tool approvals (spec
// §7).
//
// Checked AFTER the gate, and only for the 'prompt' tier. Both call sites
// (llm_agent/sdk/engine.mjs's canUseTool and llm_agent/tools/registry.mjs's
// run-bash execute) classify the command FIRST: 'blocked' denies outright and
// 'auto' runs outright, neither one consulting this table. A row here only
// ever skips the interactive approval a 'prompt'-tier command would otherwise
// park — it can never promote a blocked command, which is why the ordering
// matters: checking always-allow first would let a tool always-allowed once
// for a safe command bypass the blocklist for every later invocation.
import { getDb, requireUser, lazyPrepare } from './db.mjs';

export function hasAlwaysAllow(userId, toolName) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db, 'SELECT 1 FROM tool_approvals WHERE user_id = ? AND tool_name = ?').get(userId, toolName);
  return !!row;
}

export function setAlwaysAllow(userId, toolName) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, 'INSERT OR IGNORE INTO tool_approvals (user_id, tool_name) VALUES (?, ?)').run(userId, toolName);
}

// The revocation half. Until this existed, "Always Allow" was a ONE-WAY door:
// a user who granted it once (for bash, say) had no way to take it back from
// any surface — the grant outlived the chat, the project and the app restart,
// with no UI that even listed it. A standing permission the user cannot see or
// withdraw is the wrong default for a tool that can edit files and run shell
// commands, however sound the gate in front of it is.

export function listAlwaysAllow(userId) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(
    db,
    'SELECT tool_name, created_at FROM tool_approvals WHERE user_id = ? ORDER BY created_at DESC, tool_name ASC',
  ).all(userId).map((r) => ({ toolName: r.tool_name, grantedAt: r.created_at }));
}

/** Revoke ONE tool's standing approval. Returns true when a row was removed. */
export function clearAlwaysAllow(userId, toolName) {
  requireUser(userId);
  const db = getDb();
  const info = lazyPrepare(db, 'DELETE FROM tool_approvals WHERE user_id = ? AND tool_name = ?')
    .run(userId, toolName);
  return info.changes > 0;
}

/** Revoke every standing approval for this user. Returns the number removed. */
export function clearAllAlwaysAllow(userId) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(db, 'DELETE FROM tool_approvals WHERE user_id = ?').run(userId).changes;
}
