-- Typed record ABOUT each project-memory fact (kb/memory-ledger.mjs).
--
-- The fact's CONTENT stays in <repo>/system/memory/chat-memory.md — the
-- reader, the Mac viewer and a hand edit all work on that file. What the file
-- cannot carry lives here: category, first learned / last confirmed, how many
-- turns confirmed it, which chat taught it, and whether it was superseded.
-- A byte-identical restatement is deliberately a no-op for the file (else the
-- extractor would rewrite it every turn); here it is a confirmation, which the
-- reader uses to rank a re-confirmed fact ahead of a stale one.
--
-- Keyed by core/fact-key.mjs factIndex — the same identity the file's
-- upsert-in-place uses — so a reworded restatement under the same `[cat|id]`
-- is one row. Small (≤ maxFacts per repo), created empty: nothing to backfill.

CREATE TABLE project_memory_ledger (
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_root           TEXT NOT NULL,
  fact_index          TEXT NOT NULL,
  category            TEXT,
  first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_confirmed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  confirmations       INTEGER NOT NULL DEFAULT 1,
  source_chat_session TEXT,
  last_chat_session   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  PRIMARY KEY (user_id, repo_root, fact_index)
);
