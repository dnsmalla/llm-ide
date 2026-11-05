-- Sub-project 1: identity, profile, sessions, audit. Tokens are stored only as SHA-256 hex.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  language TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_passkey', 'active')),
  webauthn_user_id BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  recovered_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'recovery')),
  email TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_tokens_email ON email_tokens(email, purpose);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'signin')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('full', 'setup')),
  via TEXT NOT NULL CHECK (via IN ('passkey', 'signup', 'recovery')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_at INTEGER NOT NULL,
  ip TEXT,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

-- No foreign key: the audit trail outlives a deleted account (pseudonymous user id only).
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT,
  event TEXT NOT NULL,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_user ON audit_events(user_id, at);
