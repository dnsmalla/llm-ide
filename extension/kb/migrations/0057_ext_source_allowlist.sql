-- Per-user additions to the extension install allowlist (spec: docs/spec/extensions-catalog.md).
-- Additive, N-1 safe: an older server never reads this table. The list only ever ADDS to the
-- operator's list, and only within the operator's optional ceiling (enforced in code on write and read).
CREATE TABLE IF NOT EXISTS ext_source_allowlist (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sources_json TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
