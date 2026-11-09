-- 0076: desktop-claimed commands (Software Factory Phase B, B5). A command whose kind has `"runner": "desktop"` in
-- the registry is created on the desktop approval but never run by the core: the desktop app claims the job with a
-- lease renewed by heartbeat, and an expired lease becomes `interrupted` in the minute sweep. The core runner's claim
-- query only takes `runner = 'core'` rows.
ALTER TABLE jobs ADD COLUMN runner TEXT NOT NULL DEFAULT 'core';
ALTER TABLE bus_commands ADD COLUMN claimed_by TEXT;
ALTER TABLE bus_commands ADD COLUMN claim_token_hash TEXT;
ALTER TABLE bus_commands ADD COLUMN claimed_at TEXT;
ALTER TABLE bus_commands ADD COLUMN lease_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_runner_state ON jobs(runner, state, created_at);
CREATE INDEX IF NOT EXISTS idx_bus_commands_lease ON bus_commands(state, lease_expires_at);
