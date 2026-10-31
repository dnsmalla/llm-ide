-- Workspace trust (MASTER-PLAN Security; spec: docs/spec/extensions-catalog.md "Workspace trust").
-- Additive, N-1 safe: an older server never reads this table.
-- One row per (user, real folder path) the user explicitly marked trusted or untrusted.
-- No row means untrusted. Nothing in the server ever writes a trusted row on its own.
CREATE TABLE IF NOT EXISTS workspace_trust (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  trusted    INTEGER NOT NULL CHECK (trusted IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, path)
);
