-- Host API v1 (desktop host): paired devices with hashed tokens, and each user's phone chat. Additive.
CREATE TABLE host_api_devices (
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE host_api_quick_chat (
  user_id         TEXT PRIMARY KEY,
  chat_session_id TEXT NOT NULL
);
