-- 0006 — add `meta` JSON column to meetings.
--
-- Sources already has a `meta` column (since 0001); meetings did not.
-- Per-project scoping (task 12 of per-project-workspaces) needs a
-- place to stash a projectId tag on each meeting without a dedicated
-- column, so we add the same JSON-blob convention that sources/plans/
-- entities all use.  Default '{}' keeps existing rows readable.

ALTER TABLE meetings ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
