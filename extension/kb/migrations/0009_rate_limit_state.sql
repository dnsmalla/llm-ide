-- Persisted rate-limiter bucket state.  Serialised to this table on
-- the auth-GC interval (every 6 h) and on graceful shutdown (SIGTERM /
-- SIGINT), then restored on startup.
--
-- Without persistence the in-memory token buckets reset to full on
-- every server restart, which lets a client that hits 429 simply kill
-- and restart the server to get a fresh burst — bypassing the limits
-- entirely.
--
-- Each row stores one (profile, scope) bucket.  Rows older than
-- 24 hours are stale and pruned on load so the table doesn't grow
-- without bound on a long-running server.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key         TEXT PRIMARY KEY,      -- "<profileName>::<scope>"
  tokens      REAL NOT NULL,         -- current token count (fractional)
  capacity    REAL NOT NULL,
  refill_rate REAL NOT NULL,         -- tokens per second
  last_refill INTEGER NOT NULL,      -- epoch ms
  saved_at    INTEGER NOT NULL       -- epoch ms, used for staleness check
);

CREATE INDEX IF NOT EXISTS idx_rlb_saved ON rate_limit_buckets(saved_at);
