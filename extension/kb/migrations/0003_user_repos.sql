-- 0003 — server-side repo allow-list.  Replaces the client-supplied
-- `allowedRepos` array (which was tautologically validated against
-- itself) with a per-user table the server controls.  The router and
-- guardrail engine read from this table at request time and ignore
-- whatever the client sends.

CREATE TABLE IF NOT EXISTS user_repos (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  label      TEXT,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_user_repos_user ON user_repos(user_id);

-- Server-side per-user feature flags.  Reserved for things like
-- "this user has codegen-apply opted in" — currently unused but the
-- shape is here so we don't have to re-migrate when we add policy
-- knobs that aren't appropriate as env vars (e.g. per-team settings).
CREATE TABLE IF NOT EXISTS user_flags (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag      TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '1',
  set_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, flag)
);

-- Access-token revocation (jti denylist).  JWTs are stateless, so
-- "log out from all devices" or "fire this employee" used to leave
-- the access token alive until exp.  Now we record the jti here and
-- the auth middleware refuses denied tokens.  Rows expire when the
-- underlying token would have expired anyway — a daily sweep keeps
-- the table small.
CREATE TABLE IF NOT EXISTS revoked_jti (
  jti        TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_jti_expires ON revoked_jti(expires_at);
