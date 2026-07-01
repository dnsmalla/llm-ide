-- Server-side email dedup + forward-only high-water mark.
--
-- Both used to live in the Mac client's per-device UserDefaults, which
-- meant a SECOND device re-imported every message the first had already
-- turned into notes (its ledger was empty). Moving the state per-user and
-- server-side makes import device-independent and unbounded.
--
-- email_seen   — one row per (user, message-id) already imported. The id
--                rule mirrors normalizeParsed (`messageId || email-uid-<uid>`)
--                so the fetcher's seen-set lines up with what was ingested.
--                Composite PK gives us INSERT OR IGNORE dedup for free.
-- email_state  — one row per user holding the last successful fetch time,
--                used as the forward-only `since` lower bound on the next
--                fetch so we never re-scan mail we've already moved past.

CREATE TABLE IF NOT EXISTS email_seen (
  user_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS email_state (
  user_id         TEXT PRIMARY KEY,
  last_fetched_at TEXT
);
