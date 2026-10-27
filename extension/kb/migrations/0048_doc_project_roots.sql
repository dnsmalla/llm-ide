-- Per-user map from a project id to the project folder on this machine.
--
-- docs-kit (K1) routes address a project by id, never by a raw path (decision
-- 3 in docs/kits/docs-kit.md §7). The Mac registers the id -> folder pair once
-- per project open (POST /kb/projects/register); the server re-validates the
-- folder on every use, so a stale row fails closed instead of reading a path
-- the user no longer owns. Tenancy: every row is keyed by user_id.
CREATE TABLE IF NOT EXISTS doc_project_roots (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  root       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id)
);
