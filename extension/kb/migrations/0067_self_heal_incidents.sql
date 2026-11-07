-- Self-Heal incidents (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md). Debug desktop builds only: written
-- only while the core runs with LLMIDE_SELF_HEAL=1. One row per user and signature (id = 16 hex). Text is redacted
-- before it is stored (core/incident.mjs). Plan A writes new and ignored; plan B drives fixing, proposed, needsHuman,
-- fixed, attempts and the proposal columns (all nullable until then).
CREATE TABLE IF NOT EXISTS self_heal_incidents (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('ui', 'log', 'crash', 'server')),
  category             TEXT NOT NULL,
  message              TEXT NOT NULL,
  stack                TEXT,
  environmental        TEXT,
  first_seen           INTEGER NOT NULL,
  last_seen            INTEGER NOT NULL,
  count                INTEGER NOT NULL DEFAULT 1,
  attempts             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'fixing', 'proposed', 'ignored', 'needsHuman', 'fixed')),
  note                 TEXT,
  proposal_main_repo   TEXT,
  proposal_worktree    TEXT,
  proposal_branch      TEXT,
  proposal_base_commit TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_self_heal_incidents_seen ON self_heal_incidents (user_id, last_seen);
