-- Persist the code-sync `symbols` field on each plan task so savePlan→getPlan
-- round-trips compiler-derived symbol grounding (migration 0025 added the graph).
ALTER TABLE plan_tasks ADD COLUMN symbols TEXT NOT NULL DEFAULT '[]';
