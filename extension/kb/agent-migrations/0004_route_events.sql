-- agent.db: the switch history of the session router (K1 Phase 6b). Metadata only:
-- no prompts, no handoff text, never read for enforcement (the route row in the main db is).
CREATE TABLE IF NOT EXISTS agent_route_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chat_session_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_provider TEXT, from_model TEXT, to_provider TEXT, to_model TEXT,
  reason TEXT,
  cold_prefill_tokens INTEGER, handoff_chars INTEGER
);
CREATE INDEX IF NOT EXISTS idx_route_events_user_chat ON agent_route_events(user_id, chat_session_id, at);
