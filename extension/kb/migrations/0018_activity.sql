-- Activity feed: a durable, per-user record of auto-generated events
-- (graph/memory regen, regression, issues, comments, dispatch, outcomes,
-- meetings, email, slack).  Separate from audit_log (which is a
-- security/compliance trail with different semantics + retention).
CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,                 -- redacted JSON string (nullable)
  link       TEXT,                 -- optional deep-link target (nullable)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user_time ON activity(user_id, created_at DESC, id DESC);

-- Single per-user "last seen" cursor (v1 has no per-item read flags).
CREATE TABLE IF NOT EXISTS activity_seen (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);
