-- 0068: team members and invites (ADR 0021). users.role stays as the legacy flag.
CREATE TABLE IF NOT EXISTS members (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  team_role      TEXT NOT NULL DEFAULT 'member'
                   CHECK (team_role IN ('owner','admin','member','viewer')),
  max_mode       TEXT NOT NULL DEFAULT 'read_only'
                   CHECK (max_mode IN ('none','read_only','execute')),
  usd_cap_month  REAL NOT NULL DEFAULT 20 CHECK (usd_cap_month >= 0),  -- 0 = no cap
  granted_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invites (
  id             TEXT PRIMARY KEY,                 -- 16-byte hex
  token_hash     TEXT NOT NULL UNIQUE,             -- sha256 hex of the 32-byte token
  email          TEXT,                             -- optional: bind to one address (NOCASE compare in code)
  team_role      TEXT NOT NULL DEFAULT 'member' CHECK (team_role IN ('admin','member','viewer')),
  max_mode       TEXT NOT NULL DEFAULT 'read_only' CHECK (max_mode IN ('none','read_only','execute')),
  usd_cap_month  REAL NOT NULL DEFAULT 20 CHECK (usd_cap_month >= 0),
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  used_by        TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(created_by, created_at DESC);
-- Bootstrap: the earliest active real user is the owner; everyone else keeps full power (no regression).
INSERT OR IGNORE INTO members (user_id, team_role, max_mode, usd_cap_month)
  SELECT id, 'member', 'execute', 0 FROM users WHERE id != 'legacy';
UPDATE members SET team_role = 'owner'
  WHERE user_id = (SELECT id FROM users WHERE id != 'legacy' AND status = 'active'
                   ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC LIMIT 1);
