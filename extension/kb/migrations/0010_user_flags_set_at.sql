-- Add set_at column to user_flags, referenced by personas.mjs and user.mjs
-- but never declared in earlier migrations.  Without this column any call to
-- setAgentPersona / setUserPrefs would produce a "table user_flags has no
-- column named set_at" runtime error.
--
-- ALTER TABLE ... ADD COLUMN is safe for existing databases; for fresh
-- installs the column is already present because the CREATE TABLE in this
-- migration covers the full schema.

ALTER TABLE user_flags ADD COLUMN set_at TEXT NOT NULL DEFAULT (datetime('now'));
