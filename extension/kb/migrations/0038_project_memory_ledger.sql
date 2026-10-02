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
-- Keyed by a SHA-1 of core/fact-key.mjs factIndex — the same identity the
-- file's upsert-in-place uses, so a reworded restatement under the same
-- `[cat|id]` is one row. Hashed because an untagged fact's index IS its text:
-- the content must stay in the file only. Rows for facts that left the file
-- (viewer delete, eviction) are pruned on the next capture, so the table
-- tracks the file (≤ maxFacts per repo). Created empty: nothing to backfill.
-- Timestamps are local time, like the file's (t:YYYY-MM-DD) stamps and the
-- usage tables (a day boundary means the user's day).

CREATE TABLE project_memory_ledger (
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_root           TEXT NOT NULL,
  fact_key_hash       TEXT NOT NULL,
  category            TEXT,
  first_seen_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_confirmed_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  confirmations       INTEGER NOT NULL DEFAULT 1,
  source_chat_session TEXT,
  last_chat_session   TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  PRIMARY KEY (user_id, repo_root, fact_key_hash)
);
