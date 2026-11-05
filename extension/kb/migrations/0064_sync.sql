-- Encrypted sync through user-owned storage (docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md).
-- Additive, N-1 safe. No key or secret is stored here: keys and the MEGA login live in the vault (sync.rootKey,
-- sync.signingKey, sync.megaEmail, sync.megaPassword). store_config is non-secret (MEGA: the folder name only).
-- 'sftp' and 'box' are listed now so the later adapters (spec section 14) need no table rebuild.
CREATE TABLE IF NOT EXISTS sync_state (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sync_id         TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0,
  store_kind      TEXT NOT NULL CHECK (store_kind IN ('memory','sftp','box','mega')),
  store_config    TEXT NOT NULL DEFAULT '{}',
  epoch           INTEGER NOT NULL DEFAULT 1,
  seq             INTEGER NOT NULL DEFAULT 0,
  last_publish_at INTEGER,
  last_error      TEXT
);
CREATE TABLE IF NOT EXISTS sync_devices (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  dir          TEXT NOT NULL,
  tier         TEXT NOT NULL CHECK (tier IN ('web','ios')),
  name         TEXT NOT NULL,
  ecdh_spki    BLOB NOT NULL,
  signing_spki BLOB NOT NULL,
  added_at     INTEGER NOT NULL,
  wrap_epoch   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, device_id),
  UNIQUE (user_id, dir)
);
CREATE TABLE IF NOT EXISTS sync_published (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  file         TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  file_sha256  TEXT NOT NULL,
  plain_sha256 TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, kind)
);
CREATE TABLE IF NOT EXISTS sync_requests (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('running','done','failed')),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_requests_age ON sync_requests(user_id, device_id, received_at);
