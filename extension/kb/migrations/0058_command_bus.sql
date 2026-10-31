-- Command bus (S3, spec: docs/spec/command-bus.md). Additive, N-1 safe: an older server never reads these tables.
-- bus_commands: one row per accepted command. The job row (jobs, 0055) is created when the command may run: at once for a
--   command that needs no approval, or at approval time for T1/T2 (jobs.state has no 'awaiting_approval' and the CHECK is fixed),
--   with jobs.id = bus_commands.id. `state` here covers only the part of the life the jobs table cannot: waiting, denied, expired, cancelled while waiting.
-- job_events: the per-command event log behind GET /bus/commands/:id/events. seq is per command, from 1, gap-free
--   (assigned inside one transaction); bounded rows and bytes per command (enforced in code, kb/bus-store.mjs).
-- bus_kind_flags: the user's enable flag per kind. Absent = off. Set from the desktop only.
CREATE TABLE IF NOT EXISTS bus_commands (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  tier             TEXT NOT NULL,
  idem             TEXT NOT NULL,
  args_hash        TEXT NOT NULL,
  args_json        TEXT NOT NULL DEFAULT '{}',
  origin_client    TEXT NOT NULL,
  approval_reason  TEXT,
  state            TEXT NOT NULL DEFAULT 'enqueued'
                   CHECK (state IN ('awaiting_approval','enqueued','denied','expired','cancelled')),
  approved_by      TEXT,
  ttl_at           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at       TEXT,
  UNIQUE (user_id, idem)
);
CREATE INDEX IF NOT EXISTS idx_bus_commands_user_created ON bus_commands(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bus_commands_user_state ON bus_commands(user_id, state);

CREATE TABLE IF NOT EXISTS job_events (
  job_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  terminal   INTEGER NOT NULL DEFAULT 0,
  bytes      INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_job_events_user ON job_events(user_id, job_id);

CREATE TABLE IF NOT EXISTS bus_kind_flags (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, kind)
);
