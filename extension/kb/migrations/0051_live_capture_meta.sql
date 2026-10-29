-- live-then-archive T5.2 review: the extension releases its local copy only when
-- the server's copy provably equals what it sent. caption_hash is a SHA-256 over
-- the sanitized (speaker, text) lines BEFORE redaction, which the extension can
-- recompute (the ack's content_hash covers the redacted text and cannot be
-- recomputed client-side). language and started_at let the extension verify the
-- capture's metadata was stored too. Additive; old rows read '' / NULL and are
-- treated as "cannot verify" (the extension keeps its copy and re-sends).
ALTER TABLE live_crash_rows ADD COLUMN caption_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE live_crash_rows ADD COLUMN language TEXT NOT NULL DEFAULT '';
ALTER TABLE live_acks ADD COLUMN caption_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE live_acks ADD COLUMN language TEXT NOT NULL DEFAULT '';
ALTER TABLE live_acks ADD COLUMN started_at TEXT NOT NULL DEFAULT '';
