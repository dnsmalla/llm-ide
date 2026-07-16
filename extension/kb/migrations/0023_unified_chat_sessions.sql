-- Unified chat sessions — shared across macOS Code Assistant, extension
-- transcript chat, and Ask-the-Agent. Server is the source of truth so
-- history survives client restarts and syncs across surfaces.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id         TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT 'New chat',
  surface    TEXT NOT NULL DEFAULT 'any'
               CHECK (surface IN ('mac', 'extension', 'any')),
  mode       TEXT NOT NULL DEFAULT 'ask'
               CHECK (mode IN ('ask', 'agent', 'transcript')),
  project_id TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chat_sessions_user_updated
  ON chat_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  session_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  meta_json  TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chat_messages_session_seq
  ON chat_messages (session_id, seq ASC);
