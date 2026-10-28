-- agent.db, first schema (Stage 1a of docs/superpowers/plans/2026-10-28-agent-store.md).
--
-- A separate SQLite file beside the main DB. It holds agent-run HISTORY only:
-- runs, their tool events, the per-turn composition split, the activity feed,
-- and the daily rollups that keep old history after its raw rows are cleaned.
-- Live state (sessions, memory, permissions, approvals, personas, feedback,
-- model_limits, quota_state, usage_ledger) stays in the main DB.
--
-- Metadata only: names, sizes, counts, codes, ids and token totals. No prompt,
-- response, tool argument or error message is ever stored here.
--
-- Day key: every `day` column is the LOCAL calendar date YYYY-MM-DD computed
-- at write time (kb/agent-db.mjs localDay), the same rule as the budget
-- windows, so rollup buckets line up with local midnight.
--
-- usage_calls is NOT here (Stage 2, see plan section 0.1). Each run's token
-- totals are kept in agent_runs as a display copy only; budget reads never
-- use this file.
--
-- Tenancy: every table carries user_id; no FK to the main DB's users table
-- (a separate file). User purge is kb/agent-store.mjs purgeUser.

-- One row per user-visible unit of agent work. run_id = the chat turn id for
-- chat runs (the same value as turn_composition.turn_id).
CREATE TABLE agent_runs (
  run_id                TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  day                   TEXT NOT NULL,
  source                TEXT NOT NULL,            -- chat | loop | meeting | autotask | dispatch | review
  engine                TEXT,                     -- v2 | legacy | loop | meeting
  mode                  TEXT,
  provider              TEXT,
  model                 TEXT,
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'ok', 'error', 'cancelled', 'aborted')),
  started_at            TEXT NOT NULL,            -- UTC ISO
  ended_at              TEXT,
  duration_ms           INTEGER,
  tool_calls            INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  stop_reason           TEXT,
  error_code            TEXT,                     -- code only, never a message
  PRIMARY KEY (user_id, run_id)
);
CREATE INDEX idx_runs_user_started ON agent_runs(user_id, started_at);
CREATE INDEX idx_runs_user_day     ON agent_runs(user_id, day);

-- One row per tool call inside a run (names and sizes only).
CREATE TABLE agent_tool_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  day          TEXT NOT NULL,
  engine       TEXT NOT NULL,
  mode         TEXT,
  seq          INTEGER NOT NULL,
  tool         TEXT NOT NULL,
  result_chars INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,
  is_error     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ate_user_day ON agent_tool_events(user_id, day);
CREATE INDEX idx_ate_run      ON agent_tool_events(user_id, run_id);

-- Per-turn prompt composition. Column list = main-DB turn_composition after
-- migrations 0040 and 0044, in the same order, with `day` added. Checked by
-- tests/agent-store-schema.test.mjs against the main DB's own table.
CREATE TABLE turn_composition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  day TEXT NOT NULL,
  mode TEXT,
  model TEXT,
  resumed INTEGER NOT NULL DEFAULT 0,
  system_prompt_kind TEXT,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  system_prompt_tokens INTEGER,
  skills_append_tokens INTEGER,
  llmide_tool_tokens INTEGER,
  user_mcp_servers INTEGER,
  context_fence_tokens INTEGER,
  memory_fence_tokens INTEGER,
  skills_fence_tokens INTEGER,
  tool_result_chars INTEGER,
  tool_result_tokens INTEGER,
  sdk_context_total_tokens INTEGER,
  sdk_system_prompt_tokens INTEGER,
  sdk_system_tools_tokens INTEGER,
  sdk_mcp_tools_tokens INTEGER,
  sdk_memory_tokens INTEGER,
  sdk_messages_tokens INTEGER,
  sdk_deferred_tools_tokens INTEGER,
  sdk_categories TEXT
);
CREATE INDEX idx_tc_user_day  ON turn_composition(user_id, day);
CREATE INDEX idx_tc_user_turn ON turn_composition(user_id, id);

-- Activity feed (same columns as main-DB activity, 0018). No FK: see header.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,
  link       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activity_user_time ON activity(user_id, created_at DESC, id DESC);

CREATE TABLE activity_seen (
  user_id      TEXT PRIMARY KEY,
  last_seen_id INTEGER NOT NULL DEFAULT 0
);

-- Daily rollup of agent_runs. One row per (user, local day, kind, provider,
-- model). "kind" is the run source. provider/model are '' when the run had none.
CREATE TABLE agent_daily (
  user_id               TEXT NOT NULL,
  day                   TEXT NOT NULL,
  source                TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT '',
  model                 TEXT NOT NULL DEFAULT '',
  runs                  INTEGER NOT NULL DEFAULT 0,
  runs_error            INTEGER NOT NULL DEFAULT 0,
  runs_cancelled        INTEGER NOT NULL DEFAULT 0,
  runs_aborted          INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  tool_calls            INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, source, provider, model)
) WITHOUT ROWID;
CREATE INDEX idx_daily_user_day ON agent_daily(user_id, day);

-- Daily rollup of agent_tool_events, per (user, day, engine, tool).
CREATE TABLE agent_daily_tools (
  user_id      TEXT NOT NULL,
  day          TEXT NOT NULL,
  engine       TEXT NOT NULL,
  tool         TEXT NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, engine, tool)
) WITHOUT ROWID;

-- Global store state: schema bookkeeping, quarantine record, size thresholds,
-- dropped-row counter, last rollup / compact times.
CREATE TABLE store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-user retention and rollup watermark.
CREATE TABLE agent_user_settings (
  user_id            TEXT PRIMARY KEY,
  retention_days     INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 7 AND 365),
  last_rolled_day    TEXT,
  last_cleared_at    TEXT,
  last_cleared_scope TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
