-- Expression indexes on the *value* of json_extract(meta,'$.projectId').
--
-- Migration 0011 added partial existence indexes:
--   idx_meetings_project ON meetings(user_id) WHERE json_extract(...) IS NOT NULL
--   idx_plans_project    ON plans(user_id)    WHERE json_extract(...) IS NOT NULL
-- Those help the outcome-watcher's IS-NOT-NULL scans, but kb/project-export.mjs
-- filters by EQUALITY (json_extract(meta,'$.projectId') = ?). An existence-only
-- partial index still forces SQLite to evaluate json_extract on every candidate
-- row to compare the value. Indexing the extracted value as the second key
-- column lets SQLite seek straight to the matching project — turning the
-- per-project export from O(user's rows) into O(matching rows).
--
-- Keyed (user_id, <value>) so the tenancy filter and the equality predicate
-- are both satisfied by a single index seek. Additive: CREATE INDEX only.

CREATE INDEX IF NOT EXISTS idx_meetings_project_value
  ON meetings(user_id, json_extract(meta, '$.projectId'))
  WHERE json_extract(meta, '$.projectId') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plans_project_value
  ON plans(user_id, json_extract(meta, '$.projectId'))
  WHERE json_extract(meta, '$.projectId') IS NOT NULL;
