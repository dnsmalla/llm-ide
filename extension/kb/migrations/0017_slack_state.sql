-- Server-side Slack dedup + forward-only per-channel high-water (twin of
-- 0013_email_state.sql). Per CHANNEL because Slack `ts` ordering is
-- per-conversation; each channel advances its own watermark.
--
-- slack_seen   — one row per (user, message ts) already imported. Composite
--                PK gives INSERT OR IGNORE dedup for free.
-- slack_state  — one row per (user, channel) holding the last imported `ts`,
--                used as the `oldest` lower bound on the next fetch.

CREATE TABLE IF NOT EXISTS slack_seen (
  user_id    TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, message_ts)
);

CREATE TABLE IF NOT EXISTS slack_state (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_ts    TEXT,
  PRIMARY KEY (user_id, channel_id)
);
