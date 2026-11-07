-- 0065: per-chat continuation summary (ended-chat continuation, plan 2026-11-07-ended-chat-continuation.md).
-- Derived data: made from the chat's own record, rebuilt on a hash miss, never the only copy. One row per user
-- and chat. content_hash = archiveHash (kb/chat-lifecycle.mjs) over the turns the summary covers. source says
-- whose record it was made from: 'server' (chat_messages, deleted with them) or 'client' (the history a client
-- sent; working state, also dropped at the quit purge). No FK to chat_sessions: client chats have no row there.
CREATE TABLE IF NOT EXISTS chat_continuations (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id TEXT NOT NULL,
  summary         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  covered_turns   INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('server', 'client')),
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, chat_session_id)
);
