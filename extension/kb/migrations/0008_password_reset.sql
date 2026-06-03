-- Password reset tokens.  Each row represents one outstanding reset
-- request. Tokens are single-use and expire after 1 hour.
--
-- The raw token is NEVER stored — only its SHA-256 hex digest so a DB
-- read leak can't be used to reset arbitrary accounts.
--
-- user_id CASCADE DELETE so reset rows are pruned automatically when
-- an account is deleted (deleteUserCascade runs after this migration
-- is applied).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,           -- ISO-8601, 1 hour from creation
  used_at     TEXT DEFAULT NULL        -- set when the token is consumed
);

CREATE INDEX IF NOT EXISTS idx_prt_token  ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_prt_user   ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_prt_expiry ON password_reset_tokens(expires_at);
