-- Google connectors (plan docs/superpowers/plans/2026-10-31-google-connectors-plan.md, slices G0-G3). Additive, N-1 safe:
-- an older server never reads these tables.
-- google_accounts: one row per (user, Google account). account_id = first 12 hex of sha256 of the Google `sub`. The
--   refresh token, client id and client secret are NOT here: they live in the per-user vault under
--   google.acct.<account_id>.{refreshToken,clientId,clientSecret}. `scopes` is the GRANTED scope list (JSON array),
--   `products` the products those scopes enable (JSON array of gmail|gcal|gdrive).
-- connector_sync_state: one row per (user, connector, account): the incremental cursor (Gmail historyId, Calendar
--   syncTokens per calendar, Drive pageToken), a pending cursor that is promoted only after the client confirms it
--   wrote the notes (create first, then mark seen), the per-connector options, and the last status. Never holds a token.
CREATE TABLE IF NOT EXISTS google_accounts (
  user_id       TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  scopes        TEXT NOT NULL DEFAULT '[]',
  products      TEXT NOT NULL DEFAULT '[]',
  drive_content INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','reconnect_needed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, account_id)
);

CREATE TABLE IF NOT EXISTS connector_sync_state (
  user_id        TEXT NOT NULL,
  connector_id   TEXT NOT NULL CHECK (connector_id IN ('gmail','gcal','gdrive')),
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
