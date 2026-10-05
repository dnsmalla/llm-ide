-- Per-turn prompt composition for the v2 chat engine. The usage ledger says a
-- quick-chat first turn costs ~20k prompt tokens, but a reproduction of the
-- same turn measured ~12.6k (2026-10-05) and nothing recorded what the
-- difference was. One row per turn: what LLM-IDE put in (system prompt kind
-- and length, the turn's prompt length, attachments, images), what the SDK
-- actually loaded (from its init message: tool / MCP / agent / skill / slash
-- command counts, MCP server NAMES), whether the session was resumed, and the
-- real size of the turn's FIRST API call (input + cache write + cache read).
-- turn_id is also usage_ledger.request_id and turn_tool_events.turn_id.
--
-- Sizes, counts and names only — never prompt, attachment or tool text.
CREATE TABLE IF NOT EXISTS turn_composition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  mode TEXT,
  model TEXT,
  resumed INTEGER NOT NULL DEFAULT 0,
  system_prompt_kind TEXT,
  -- LLM-IDE-authored system text only: the append for 'preset' (the
  -- claude_code preset itself is not counted), the whole custom prompt for
  -- 'compact'. Compare within one system_prompt_kind.
  system_chars INTEGER,
  prompt_chars INTEGER,
  attached_files INTEGER,
  attachment_chars INTEGER,
  images INTEGER,
  tools INTEGER,
  mcp_tools INTEGER,
  mcp_servers TEXT,
  agents INTEGER,
  skills INTEGER,
  slash_commands INTEGER,
  claude_code_version TEXT,
  api_calls INTEGER,
  first_call_prompt_tokens INTEGER,
  first_call_cache_read_tokens INTEGER,
  first_call_cache_creation_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_composition_user_time ON turn_composition(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_composition_turn ON turn_composition(turn_id);
-- The composition report joins each turn to its ledger rows by request_id.
CREATE INDEX IF NOT EXISTS idx_usage_ledger_request ON usage_ledger(request_id);
