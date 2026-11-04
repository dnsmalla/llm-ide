-- Host API v1 security (Plan 6): the desktop host's TLS identity (one row; key vault-encrypted)
-- and the capabilities each paired device was granted (JSON array; NULL = paired before scopes).
CREATE TABLE host_api_identity (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  cert_der    BLOB NOT NULL,
  key_enc     BLOB NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  not_after   INTEGER NOT NULL
);
ALTER TABLE host_api_devices ADD COLUMN scopes TEXT;
