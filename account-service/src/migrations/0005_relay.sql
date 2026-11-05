-- Sub-project 3, relay slice R1/R2. Live envelopes are never stored; only the latest signed wrap per device waits
-- here for a device that is offline when the desktop confirms the link. Ciphertext only (relay design 2.2).
CREATE TABLE relay_wraps (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX relay_wraps_user ON relay_wraps(user_id);
