-- 0070: project registry and per-project team roles (ADR 0021 H1.3).
--
-- `projects` is the canonical, team-wide registry. Its id is the stable client-derived project id
-- (the same id Doc Gen resolves through `doc_project_roots`); `root` is the last validated folder
-- registered for it and is never used for path resolution by team routes.
--
-- `project_members` is the per-project grant. NO ROW MEANS VIEWER: read/Ask only. A global team
-- owner/admin overrides every project (team management stays theirs); a global viewer can never be
-- raised above viewer by a project row (H1.2 is not weakened).
--
-- `usage_ledger.project_id` (nullable) lets a project's monthly USD cap sum only that project's
-- spend. Rows written before this migration, and turns with no project in scope, stay NULL.
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root       TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_members (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer','member','admin','owner')),
  max_mode      TEXT NOT NULL DEFAULT 'read_only'
                  CHECK (max_mode IN ('none','read_only','execute')),
  usd_cap_month REAL NOT NULL DEFAULT 20 CHECK (usd_cap_month >= 0),
  granted_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project
  ON project_members(project_id, role);

ALTER TABLE usage_ledger ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_usage_ledger_project
  ON usage_ledger(user_id, project_id, ts);
