-- 0074: chat history per project for Host API v1 clients (phone / web).
--
-- `chat_sessions.project_id` has existed since 0023 (nullable) but had no index and no reader ever
-- filtered on it: the Host API kept ONE "Phone chat" per user. This migration gives the project scope
-- its index and one current Host API chat per (user, project).
--
-- Backfill: every session that exists before this migration is LEGACY/GLOBAL. The Host API always
-- created its phone chat with no project, so those rows stay NULL; the UPDATE below only normalizes an
-- empty string, which no pre-0074 writer ever stored. Desktop-local chat is not in this table (the
-- desktop app has its own store) and is untouched.
CREATE INDEX IF NOT EXISTS chat_sessions_user_project_updated
  ON chat_sessions (user_id, project_id, updated_at DESC);

UPDATE chat_sessions SET project_id = NULL WHERE project_id = '';

-- One current Host API chat per (user, project). project_id '' is the legacy/global chat, so an
-- existing pairing that sends no projectId keeps the same conversation it had. The old single-pointer
-- table stays for downgrade safety but is no longer read or written.
CREATE TABLE IF NOT EXISTS host_api_project_chat (
  user_id         TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

INSERT OR IGNORE INTO host_api_project_chat (user_id, project_id, chat_session_id)
  SELECT user_id, '', chat_session_id FROM host_api_quick_chat;
