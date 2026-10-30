-- Core job runner (MASTER-PLAN S6, prerequisite for automation-kit; spec: docs/spec/job-runner.md).
-- Additive, N-1 safe: an older server never reads this table.
-- One persisted queue. A job is owned by one user and sits on a lane; the partial unique
-- index is the lane lock (at most one running job per user and lane, enforced by the DB).
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  lane             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  payload_json     TEXT NOT NULL DEFAULT '{}',
  result_json      TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at       TEXT,
  finished_at      TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_state ON jobs(user_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_state_created ON jobs(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_lane_running ON jobs(user_id, lane) WHERE state = 'running';
