-- agent.db, usage shadow (Stage 2a of docs/superpowers/plans/2026-10-28-agent-store.md, sections 0.1, 2.3).
--
-- usage_calls mirrors the MAIN DB's usage_ledger row for row. It is a SHADOW
-- in this stage: the ledger stays authoritative, every budget and limit read
-- still uses usage_ledger, and nothing reads this table for enforcement.
-- The shadow exists so the cutover (Stage 2b) can be gated on a measured
-- comparison (kb/agent-usage.mjs compareLedgerShadow).
--
-- Column names match usage_ledger so the readers' SQL changes only in the
-- table name. Two additions: `day` (local calendar date YYYY-MM-DD, the day key
-- of the plan, always the date part of `ts`) and `is_internal` (endpoint LIKE
-- '%:internal' at write time, as the readers' filter computes it).
--
-- Ids: rows copied from the ledger keep the ledger id (kb/agent-history-copy.mjs,
-- ids <= the boot-time floor); rows mirrored live take the next AUTOINCREMENT
-- id, which the boot step raises above that floor. The two ranges never meet.
--
-- Retention: raw rows only, kept as long as the ledger (90 days, pruned by
-- kb/agent-usage.mjs pruneUsageCalls). No rollup in this stage. Clear never
-- deletes usage_calls: a budget must not reset because a user cleared history.
--
-- Metadata only: no prompt, response or error text.

CREATE TABLE usage_calls (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                TEXT NOT NULL,
  day                    TEXT NOT NULL,            -- YYYY-MM-DD local, = substr(ts, 1, 10)
  ts                     TEXT NOT NULL,            -- YYYY-MM-DD HH:MM:SS local (window compares)
  provider               TEXT NOT NULL,
  model                  TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'api',
  endpoint               TEXT,                     -- clamped 128
  is_internal            INTEGER NOT NULL DEFAULT 0,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  cache_read_tokens      INTEGER,
  cache_creation_tokens  INTEGER,
  runs                   INTEGER NOT NULL DEFAULT 1,
  request_id             TEXT,
  turns                  INTEGER,
  stop_reason            TEXT
);
CREATE INDEX idx_uc_user_prov_model_day ON usage_calls(user_id, provider, model, day);
CREATE INDEX idx_uc_user_ts             ON usage_calls(user_id, ts);
CREATE INDEX idx_uc_request             ON usage_calls(request_id);
