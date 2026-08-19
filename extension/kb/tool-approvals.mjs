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
