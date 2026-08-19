//
// Per-(user, tool) "always allow" persistence for act-tool approvals (spec
// §7). Checked BEFORE the gate runs — a row here skips straight to
// auto-run; a BLOCKED classification is never overridden by a row here (the
// gate always checks its blocklist first, independent of this table).
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
