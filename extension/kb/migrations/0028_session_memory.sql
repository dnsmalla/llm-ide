-- Session-scoped memory: facts extracted from ONE chat session's turns,
-- distinct from the file-based project memory (chat-memory.md). Deleted
-- wholesale when the session is cleared or removed — unlike project memory,
-- which is edit-only and never auto-pruned by session lifecycle.
CREATE TABLE IF NOT EXISTS session_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fact       TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS session_memory_user_session
  ON session_memory (user_id, session_id);
