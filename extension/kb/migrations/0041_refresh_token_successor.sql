-- Refresh-token rotation grace window. When a refresh token is rotated, the
-- old row records the id of the token that replaced it. A client whose
-- /auth/refresh response was lost (timeout, sleep, blocked event loop) still
-- holds the old token; if it presents it again shortly after rotation and the
-- successor was never used, server/users.mjs#refreshSession treats it as a
-- retry instead of theft. NULL = revoked by logout / logoutAll (never a
-- rotation), which keeps the theft response.
ALTER TABLE refresh_tokens ADD COLUMN replaced_by TEXT;
