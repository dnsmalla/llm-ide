-- 0002 — multi-tenancy.  Adds users, audit log, encrypted vault, and
-- a `user_id` foreign key on every row that represents owned data.
-- Existing rows in legacy single-user databases are migrated to a
-- synthetic "legacy" user so they remain accessible after upgrade.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                  -- 16-byte hex
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,                     -- bcrypt, 60 chars
  role          TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Refresh-token store.  We use short-lived access JWTs (15 min) backed
-- by long-lived rotated refresh tokens.  Refresh tokens are stored
-- hashed (sha256) so a DB leak doesn't allow direct session hijack.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Per-user encrypted credential vault (GitHub tokens, Backlog API
-- keys, Slack webhooks, Linear keys).  `ciphertext` is AES-256-GCM
-- output (12-byte iv prefix || ciphertext || 16-byte tag).  The data
-- key is derived from a server-wide master key + the user_id via HKDF
-- — no plaintext credential ever lives at rest.
CREATE TABLE IF NOT EXISTS user_secrets (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_key  TEXT NOT NULL,             -- e.g. 'github.token', 'slack.webhook'
  ciphertext  BLOB NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, secret_key)
);

-- Append-only audit log.  Recorded for every state-mutating call.
-- Indexed by (user_id, created_at) so per-user audit pulls are fast.
-- Never deleted; rotation is a separate ops concern.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  request_id  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  action      TEXT NOT NULL,             -- e.g. 'plan.create', 'review.approve'
  resource    TEXT,                      -- e.g. plan id / task id
  outcome     TEXT NOT NULL DEFAULT 'success'
                CHECK (outcome IN ('success','failure','denied')),
  detail      TEXT,                      -- JSON, redacted
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_log(action, created_at DESC);

-- Add user_id columns to existing owned tables.  ALTER TABLE ADD COLUMN
-- is non-destructive and SQLite supports it natively.  We default to
-- 'legacy' so any pre-multitenancy data stays accessible to a special
-- legacy user we provision in the runtime.
ALTER TABLE meetings     ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);
ALTER TABLE entities     ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);
ALTER TABLE sources      ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);
ALTER TABLE plans        ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);
ALTER TABLE plan_tasks   ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);
ALTER TABLE review_items ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);
ALTER TABLE outcomes     ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_meetings_user     ON meetings(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_entities_user     ON entities(user_id);
CREATE INDEX IF NOT EXISTS idx_sources_user      ON sources(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_plans_user        ON plans(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_user   ON plan_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_review_items_user ON review_items(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_user     ON outcomes(user_id, observed_at DESC);

-- Provision the legacy user for any pre-existing data.  Email is
-- intentionally non-functional so it can't be used to log in.
INSERT OR IGNORE INTO users (id, email, display_name, password_hash, role, status)
VALUES ('legacy', 'legacy@local', 'Legacy data',
        '$2b$12$INVALID.HASH.NEVER.MATCHES.ANY.PASSWORD.AT.ALL.LEGACY.USER', 'user', 'disabled');
