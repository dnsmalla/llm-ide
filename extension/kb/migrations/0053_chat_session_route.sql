-- K1 Phase 6b, session router (docs/superpowers/plans/2026-10-30-agent-kit-k1.md, section 14).
-- Additive: nothing reads these on the turn path unless LLMIDE_ROUTER is on.
--
-- 1. chat_session_route: the per-chat provider/model pick and the session token cap.
--    It lives in the MAIN db (not agent.db) because the cap must fail CLOSED: agent.db is
--    "history, never enforcement" and may be down. The counters are the enforcement copy.
--    Billable tokens = input + output + cache write (the same rule as usage.mjs); cache
--    reads are tracked but never counted against the cap.
CREATE TABLE IF NOT EXISTS chat_session_route (
  user_id            TEXT NOT NULL,
  chat_session_id    TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  pinned_by          TEXT NOT NULL DEFAULT 'user',
  sticky_until       TEXT,
  token_limit        INTEGER,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  warm_json          TEXT NOT NULL DEFAULT '{}',
  handoff_note       TEXT,
  handoff_up_to      TEXT,
  switch_seq         INTEGER NOT NULL DEFAULT 0,
  pending_json       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, chat_session_id)
);

-- 2. provider_learned_limits: per-key limits seen in rate-limit headers and 429s, so catalog
--    connections (which getLimits does not know) get a limit_near check. A 'user' source wins
--    and never expires; learned rows expire after 24 h without a fresh observation.
CREATE TABLE IF NOT EXISTS provider_learned_limits (
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  rpm         INTEGER,
  rpd         INTEGER,
  tpm         INTEGER,
  tpd         INTEGER,
  source      TEXT NOT NULL DEFAULT 'header' CHECK (source IN ('header','429','user')),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, provider, model)
);
