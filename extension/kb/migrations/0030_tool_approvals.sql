-- Per-user "always allow" persistence for act-tool approvals (spec §7,
-- §12: blocked patterns are NEVER overridable by a row here — the gate
-- checks BLOCKED_PATTERNS first, unconditionally, before this table is
-- ever consulted).
CREATE TABLE IF NOT EXISTS tool_approvals (
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, tool_name)
);
