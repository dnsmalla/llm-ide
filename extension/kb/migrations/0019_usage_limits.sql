-- Per-user model usage metering + same-provider auto-fallback limits.
--
-- usage_ledger: append-only record of every model invocation across all
-- dispatch paths — chat/review (runClaude + provider HTTP) and the Mac Auto
-- Tasks CLI, which reports in over POST /kb/usage/record. input/output tokens
-- are nullable because logged-in CLI/subscription mode can't report them; those
-- rows still count as one "run" for run-based limits.
--
-- model_limits: the user-set caps (the control side of "like Claude's
-- settings"). One row per (user, provider, model) the user has customised —
-- defaults live in code (usage.mjs DEFAULT_CHAINS) so an untouched provider
-- needs no rows. `priority` orders the same-provider fallback chain (lower =
-- tried first). limit_value 0 means "no cap" (the inert default), so the
-- feature changes nothing until the user sets real caps.
--
-- quota_state: reactive exhaustion flags. Set when a live 429/quota error fires
-- for a model; keyed by the window it happened in so a stale row for a previous
-- window is simply ignored (natural self-expiry, no GC needed).
--
-- All three are tenant-scoped with ON DELETE CASCADE; deleteUserCascade in
-- db.mjs also deletes them explicitly so the deletion receipt is complete.

CREATE TABLE IF NOT EXISTS usage_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'api',     -- 'api' | 'cli' | 'auto-task'
  endpoint      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  runs          INTEGER NOT NULL DEFAULT 1,
  request_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_user_prov_model_ts
  ON usage_ledger(user_id, provider, model, ts);

CREATE TABLE IF NOT EXISTS model_limits (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  limit_value   INTEGER NOT NULL DEFAULT 0,      -- 0 = no cap
  unit          TEXT NOT NULL DEFAULT 'runs',    -- 'runs' | 'tokens'
  window_kind   TEXT NOT NULL DEFAULT 'daily',   -- 'daily' | 'monthly'
  threshold_pct INTEGER NOT NULL DEFAULT 90,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, provider, model)
);

CREATE TABLE IF NOT EXISTS quota_state (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  window_start TEXT NOT NULL,                    -- sqlite localtime string of the window's start
  exhausted    INTEGER NOT NULL DEFAULT 1,
  hit_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, provider, model, window_start)
);
