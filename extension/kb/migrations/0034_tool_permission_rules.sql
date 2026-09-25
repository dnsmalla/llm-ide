-- Claude-style permission rules: "Yes, and don't ask again for <rule> in this
-- project". Replaces the per-(user, tool) global grant in tool_approvals
-- (0030), which was both too coarse — one "Always Allow Bash" let EVERY
-- shell command run unasked in EVERY repo — and, in practice, dead: the Mac's
-- only asking mode told the server to ignore it.
--
--   project_root  resolved workspace root the rule applies to
--   tool_name     'Bash' | 'Edit' | 'Write' | an llmide act tool (e.g. 'run-bash')
--   pattern       Bash/run-bash: a command prefix ('npm test', 'git status');
--                 '' = the tool itself (act tools)
--
-- The safety gate still runs first: a rule only ever skips the PROMPT tier,
-- never a blocked command or a write outside the workspace.
CREATE TABLE IF NOT EXISTS tool_permission_rules (
  user_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  pattern TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, project_root, tool_name, pattern)
);
