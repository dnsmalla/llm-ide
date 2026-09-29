-- Per-turn tool accounting. The usage ledger records a turn's tokens but not
-- what the model DID, so "does the code graph save tokens?" was unanswerable:
-- skill_invoked audit lines live only in kb/server.log, rotated every start.
--
-- One row per tool call the model made in a turn — native (Read, Grep, Bash…)
-- and llmide MCP tools (normalized to their bare name, e.g. find-code) — plus
-- the legacy engine's always-on repo-memory push (tool = 'memory_push').
-- turn_id is also written as usage_ledger.request_id, which is the join.
--
-- Names and sizes only. Tool arguments and results carry file contents, shell
-- commands and user prose; none of it belongs here.
CREATE TABLE IF NOT EXISTS turn_tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  mode TEXT,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  result_chars INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  is_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_tool_events_user_time ON turn_tool_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_tool_events_turn ON turn_tool_events(turn_id);
