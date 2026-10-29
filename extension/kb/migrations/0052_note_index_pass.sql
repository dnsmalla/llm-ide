-- live-then-archive Phase 2 (review): when a project's note index last had a COMPLETE pass
-- (a reconcile or a final scan chunk), whether or not any row changed. Staleness is judged from
-- this, so a stable library is not reported stale. Derived data: safe to drop and rebuild.
CREATE TABLE IF NOT EXISTS note_index_pass (
  user_id            TEXT NOT NULL,
  project_id         TEXT NOT NULL DEFAULT '',
  last_reconciled_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
