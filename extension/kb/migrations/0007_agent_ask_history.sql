-- Per-user, append-only history for the Ask-the-Agent sheet.
--
-- The sheet was originally in-memory only ("quick check-in, not a
-- conversation"). User feedback flipped that: people want to scroll
-- back through what they asked yesterday and resume.
--
-- Schema notes
--   - One row per turn (user OR assistant).
--   - PRIMARY KEY (user_id, seq) gives stable per-user ordering
--     without needing client-side ids; `seq` is auto-incremented per
--     user via the trigger below.
--   - role is constrained to two values so we don't drift later.
--   - created_at is unix-seconds (matches the rest of the schema).

CREATE TABLE IF NOT EXISTS agent_ask_messages (
  user_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (user_id, seq)
);

-- Newest-first scans (for the sheet's "load recent" call) hit this.
CREATE INDEX IF NOT EXISTS agent_ask_messages_user_seq
  ON agent_ask_messages (user_id, seq DESC);
