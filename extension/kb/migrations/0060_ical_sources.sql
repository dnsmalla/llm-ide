-- iCal feed connector (spec docs/spec/calendar-ical.md). Additive.
-- ical_sources: one row per (user, feed). source_id is 12 random hex characters (never derived from the URL). The feed
--   URL is a bearer secret (Google's "Secret address in iCal format") and lives ONLY in the per-user vault under
--   ical.src.<source_id>.url; it is not stored here. name is the user's label, id_prefix a short non-secret hint (the
--   first characters of the calendar id), host the allowlisted host.
-- connector_sync_state: its connector_id CHECK is widened to admit 'ical' (SQLite cannot alter a CHECK, so the table is
--   rebuilt with the same columns and rows). For 'ical', account_id holds the source_id. The cursor holds the HTTP
--   validators (ETag, Last-Modified), a body hash and the day of the last full pass, never the URL.
CREATE TABLE IF NOT EXISTS ical_sources (
  user_id    TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  id_prefix  TEXT NOT NULL DEFAULT '',
  host       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, source_id)
);

CREATE TABLE connector_sync_state_v2 (
  user_id        TEXT NOT NULL,
  connector_id   TEXT NOT NULL CHECK (connector_id IN ('gmail','gcal','gdrive','ical')),
  account_id     TEXT NOT NULL,
  cursor         TEXT,
  pending_cursor TEXT,
  options        TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'idle',
  last_error     TEXT,
  last_run_at    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, connector_id, account_id)
);
INSERT INTO connector_sync_state_v2 (user_id, connector_id, account_id, cursor, pending_cursor, options, status, last_error, last_run_at, updated_at)
  SELECT user_id, connector_id, account_id, cursor, pending_cursor, options, status, last_error, last_run_at, updated_at FROM connector_sync_state;
DROP TABLE connector_sync_state;
ALTER TABLE connector_sync_state_v2 RENAME TO connector_sync_state;
