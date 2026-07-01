-- Per-user, cross-machine app settings blob.
--
-- Stores only NON-SECRET client config (saved GitLab/GitHub project lists,
-- provider choice, active project) as an opaque JSON string, so opening the app
-- on another machine can restore the same Issues/Gantt view. Access tokens are
-- NEVER stored here — they stay in each machine's Keychain.
--
-- Tenant-scoped with ON DELETE CASCADE; deleteUserCascade in db.mjs also
-- deletes the row explicitly so the deletion receipt is complete.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json       TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
