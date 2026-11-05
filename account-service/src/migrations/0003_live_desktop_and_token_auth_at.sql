-- I3: the one-desktop rule counts only live desktops, so a revoked or replaced desktop frees the slot
-- (its row stays for the account history). auth_at carries the passkey proof time from the web
-- session through the OAuth code into every desktop token of that sign-in, so "replace desktop"
-- (design 4.7) can require a fresh (5 min) passkey proof from a Bearer request.
DROP INDEX devices_one_desktop_per_user;
CREATE UNIQUE INDEX devices_one_live_desktop_per_user ON devices(user_id) WHERE kind = 'desktop' AND status <> 'revoked';
ALTER TABLE oauth_codes ADD COLUMN auth_at INTEGER;
ALTER TABLE desktop_tokens ADD COLUMN auth_at INTEGER;
