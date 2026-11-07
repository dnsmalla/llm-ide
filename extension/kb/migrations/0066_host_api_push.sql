-- Push targets of paired Host API devices (push notifications plan). One per device; the row goes with its device.
-- The endpoint / token are useless without the vault-held VAPID key / APNs .p8, so they are stored as is.
CREATE TABLE host_api_push (
  user_id     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('webpush', 'apns')),
  endpoint    TEXT,
  p256dh      TEXT,
  auth        TEXT,
  token       TEXT,
  environment TEXT CHECK (environment IS NULL OR environment IN ('sandbox', 'production')),
  created_at  INTEGER NOT NULL,
  last_result TEXT,
  last_at     INTEGER,
  PRIMARY KEY (user_id, device_id),
  FOREIGN KEY (user_id, device_id) REFERENCES host_api_devices (user_id, device_id) ON DELETE CASCADE
);
