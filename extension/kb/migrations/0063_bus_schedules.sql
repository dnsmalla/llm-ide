-- Desktop schedules for command-bus kinds (spec docs/spec/command-bus.md section 9). Additive, N-1 safe.
-- No server timer reads this table: the desktop enqueues each run itself (idem sched:<id>:<slot>) and approves it,
-- on the standing approval only while standing_until is in the future. bus_commands.schedule_id is set only for a run
-- that was approved on a standing approval; the executor re-checks that schedule before the run starts.
CREATE TABLE IF NOT EXISTS bus_schedules (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  args_json      TEXT NOT NULL DEFAULT '{}',
  args_hash      TEXT NOT NULL,
  interval_ms    INTEGER NOT NULL CHECK (interval_ms >= 3600000 AND interval_ms <= 604800000),
  standing_until TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_run_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bus_schedules_user ON bus_schedules(user_id, created_at);
ALTER TABLE bus_commands ADD COLUMN schedule_id TEXT;
