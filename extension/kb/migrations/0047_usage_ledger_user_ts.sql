-- Index usage_ledger by (user_id, ts).
--
-- GET /kb/os/state sums a user's usage over a time window grouped by model,
-- source and endpoint. The existing index is (user_id, provider, model, ts),
-- so a window filter across all models could not seek on ts and scanned every
-- ledger row the user ever had — on each System view refresh. Heavy users
-- (round-the-clock auto tasks) have the most rows.
CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_ledger(user_id, ts);
