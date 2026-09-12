-- Cache tokens on the usage ledger.
--
-- Until now the ledger recorded `input_tokens`/`output_tokens` only, and on
-- the Agent engine those are the tokens that were NOT served from cache — a
-- small remainder. The bulk of a turn's input is cache reads (billed ~0.1x)
-- and cache creation (billed ~1.25x), and cache creation was never even read
-- off the SDK's usage block. The ledger therefore reported ~60 input tokens
-- for Opus turns whose system prompt alone is thousands, and a token-unit cap
-- summing those columns was measuring a fraction of the real volume.
--
-- Kept as separate columns rather than folded into input_tokens because the
-- three price differently: folding them would trade one wrong number for
-- another. Nullable, so every pre-existing row stays honestly "unknown"
-- rather than silently becoming zero.
ALTER TABLE usage_ledger ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE usage_ledger ADD COLUMN cache_creation_tokens INTEGER;
