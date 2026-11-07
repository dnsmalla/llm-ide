-- 0069: USD cost per usage ledger row (ADR 0021 H1, R-007#1). The member's monthly cap needs a real
-- month sum; the ledger only carried tokens and runs. Nullable: a CLI-dispatched turn reports no cost,
-- so the month sum under-counts those turns (upgrade when the CLI reports usage).
ALTER TABLE usage_ledger ADD COLUMN cost_usd REAL;
