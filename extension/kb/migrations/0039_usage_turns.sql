-- How many model round trips a run took, and why it stopped.
--
-- The ledger records tokens, but on the Agent engine the cost of a run is
-- (context size) x (round trips): every turn re-reads the whole context, so two
-- runs with the same prompt can differ ten-fold in cache reads purely because
-- one took 6 turns and the other 40. Measured 2026-10-05: the Loop's headless
-- agent steps are ~69% of recent cache-read volume and heavy-tailed (the top
-- 20% of steps are half of it) — but the turn count the SDK reports was
-- thrown away, so "which runs hit the cap, and how many turns is typical" could
-- not be answered afterwards.
--
-- `turns` is the SDK's `num_turns` for the whole run, stored on the row of the
-- PRIMARY model only (a run that also used a small helper model writes one row
-- per model; repeating the count there would double it). `stop_reason` is the
-- SDK's result subtype ('success', 'error_max_turns', ...) or 'timeout' /
-- 'aborted' / 'error' for a run that never produced a result.
-- Both nullable, so every pre-existing row stays honestly "unknown".
ALTER TABLE usage_ledger ADD COLUMN turns INTEGER;
ALTER TABLE usage_ledger ADD COLUMN stop_reason TEXT;
