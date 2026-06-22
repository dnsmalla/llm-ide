-- Per-user access-token cutoff (unix seconds; 0 = never revoked).
-- logoutAll (refresh-reuse theft detection, password change) and password
-- reset set this to "now"; the auth middleware rejects any access token whose
-- iat predates it. This makes a "revoke all sessions" action invalidate
-- outstanding ACCESS tokens too, not just refresh tokens -- so a stolen bearer
-- token cannot outlive a revocation by its (<=15 min) TTL.
ALTER TABLE users ADD COLUMN tokens_valid_after INTEGER NOT NULL DEFAULT 0;
