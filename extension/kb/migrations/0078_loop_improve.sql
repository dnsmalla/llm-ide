-- 0078: Loop self-improvement storage. Signals are what a Loop's runs and its user leave behind;
-- improvements are the reviewed proposals drawn from them; the cursor marks how far the last review read.
-- `run_finished` is unique per (user, loop, run) so a client that re-posts a finished run cannot inflate
-- the counts the review and the outcome check rely on.
CREATE TABLE IF NOT EXISTS loop_signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  loop_id    TEXT NOT NULL,
  stage_key  TEXT,
  kind       TEXT NOT NULL CHECK (kind IN
               ('run_finished','loop_edited','sent_back','human_review','output_edited','improvement_outcome')),
  run_id     TEXT,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loop_signals_loop
  ON loop_signals(user_id, project_id, loop_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS loop_signals_run_once
  ON loop_signals(user_id, loop_id, run_id)
  WHERE kind = 'run_finished' AND run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS loop_improvements (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  loop_id         TEXT NOT NULL,
  template_key    TEXT,
  stage_key       TEXT,
  change          TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  evidence        TEXT NOT NULL,
  suggested_scope TEXT CHECK (suggested_scope IN ('project','general')),
  status          TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','reverted','superseded')),
  scope           TEXT CHECK (scope IN ('project','general')),
  origin          TEXT NOT NULL DEFAULT 'review',
  baseline        TEXT,
  outcome         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_loop_improvements_status
  ON loop_improvements(user_id, status, scope);

CREATE TABLE IF NOT EXISTS loop_improve_cursor (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  loop_id    TEXT NOT NULL,
  cursor     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, project_id, loop_id)
);

CREATE TABLE IF NOT EXISTS loop_improve_dismissals (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id, improvement_id)
);
