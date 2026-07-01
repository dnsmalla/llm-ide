-- Per-user scheduling overlay for repository issues.
--
-- GitHub issues carry no start date, due date, estimate, or dependency
-- fields — so a real gantt can't be drawn from GitHub data alone. This
-- table is OUR overlay: it stores the scheduling metadata a gantt needs,
-- keyed by (provider, repo, issue number), entirely in our system. The
-- backend never talks to GitHub; the Mac app reads issues from the provider
-- API and merges this overlay client-side. GitLab already has native
-- scheduling fields, so in practice rows are written for provider='github',
-- but the column is kept generic for future providers.
--
-- Tenant-scoped with ON DELETE CASCADE; deleteUserCascade in db.mjs also
-- deletes rows explicitly so the deletion receipt is complete.

CREATE TABLE IF NOT EXISTS issue_schedule (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,                      -- 'github' (generic for future)
  repo          TEXT NOT NULL,                      -- 'owner/name'
  issue_number  INTEGER NOT NULL,
  start_date    TEXT,                               -- 'YYYY-MM-DD' or null
  due_date      TEXT,                               -- 'YYYY-MM-DD' or null
  estimate_days REAL,                               -- >= 0 or null
  depends_on    TEXT NOT NULL DEFAULT '[]',         -- JSON array of issue numbers
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (user_id, provider, repo, issue_number)
);
CREATE INDEX IF NOT EXISTS idx_issue_schedule_user_repo
  ON issue_schedule(user_id, provider, repo);
