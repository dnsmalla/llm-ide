-- Sub-project 2, device linking v1. Public values only: commitments, public keys, nonces and a
-- client-held device-token hash. The private keys never leave the device that generated them.
CREATE TABLE link_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  commitment TEXT NOT NULL,
  device_nonce TEXT,
  desktop_nonce TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'keys', 'linked', 'unlinked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX link_requests_user_state ON link_requests(user_id, state, expires_at);
-- A device token is client-generated (the server only stores its hash), so two devices can never
-- share one. Null until the device reveals its keys.
CREATE UNIQUE INDEX devices_token_hash_unique ON devices(token_hash) WHERE token_hash IS NOT NULL;
