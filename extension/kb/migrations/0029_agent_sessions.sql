-- 0029: Agent v2 engine sessions — maps a Mac ChatSession UUID to the
-- Claude Agent SDK session id so turns can resume server-side.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_scope TEXT NOT NULL DEFAULT 'explorer',
  mac_chat_session_id TEXT NOT NULL,
  sdk_session_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_mode TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_user_chat ON agent_sessions(user_id, mac_chat_session_id);
