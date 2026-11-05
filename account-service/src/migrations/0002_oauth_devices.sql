-- Sub-project 2: desktop OAuth 2.0 authorization code + PKCE and the device registry.
-- OAuth codes and desktop access/refresh tokens are stored only as SHA-256 hex.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX oauth_codes_user ON oauth_codes(user_id, created_at);

CREATE TABLE desktop_tokens (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  code_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX desktop_tokens_user ON desktop_tokens(user_id);
CREATE INDEX desktop_tokens_family ON desktop_tokens(family);
CREATE INDEX desktop_tokens_code ON desktop_tokens(code_hash);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'ios', 'web')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'unlinked', 'revoked')),
  signing_key TEXT NOT NULL,
  ecdh_key TEXT NOT NULL,
  token_hash TEXT,
  tier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  linked_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX devices_user ON devices(user_id);
-- v1 has one desktop per account (design A6/4.7). "Replace desktop" updates this row; it never
-- inserts a second one, so the partial unique index holds for every status.
CREATE UNIQUE INDEX devices_one_desktop_per_user ON devices(user_id) WHERE kind = 'desktop';
