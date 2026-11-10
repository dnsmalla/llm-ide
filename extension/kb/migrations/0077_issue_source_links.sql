-- 0077: the durable Sources -> Issue record (Task 9, decision D15). One row per meeting action filed as an issue, so a
-- re-run, or a run after a core restart, never files the same action twice (the writer's idempotency map is in memory
-- for 10 minutes only). Keyed per user; the text hash keeps an action whose wording changed as a new item.
CREATE TABLE IF NOT EXISTS issue_source_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  repo TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  issue_number INTEGER,
  issue_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider, repo, source_ref, text_hash)
);
