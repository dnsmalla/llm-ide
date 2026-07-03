-- 0022 — make sources uniqueness per-user.
--
-- The `sources` UNIQUE constraint has been `UNIQUE(kind, ref, chunk_idx)`
-- since 0001 — GLOBAL, not per-tenant (0002 added the user_id column but
-- never widened the constraint). `ingestSources` compensates with a
-- per-user delete-then-insert, but that only clears the *calling* user's
-- row: if two users ingest the same (kind, ref, chunk_idx), the second
-- user's INSERT hits SQLITE_CONSTRAINT and its whole transaction rolls
-- back. Local git refs (absolute paths) and Slack channels are per-user so
-- this was latent, but the Box connector's refs are `box:<folderId>:<fileId>`
-- — Box folder/file IDs are enterprise-shared, so two users indexing the
-- same team folder is the common case, and the second user's index is left
-- EMPTY (deleteSourcesByPrefix already ran). Widening the constraint to
-- include user_id fixes this for every Pattern-A connector.
--
-- SQLite can't ALTER a UNIQUE constraint, so recreate the table (same
-- recipe as 0005). The migration runner wraps this in a transaction.

-- Drop dependent triggers first; they reference the table by name.
DROP TRIGGER IF EXISTS trg_sources_ai;
DROP TRIGGER IF EXISTS trg_sources_au;
DROP TRIGGER IF EXISTS trg_sources_ad;

-- Replacement table: identical to the post-0005 shape except the UNIQUE
-- key now leads with user_id.
CREATE TABLE sources_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('code','ticket','qa','doc')),
  ref         TEXT NOT NULL,
  chunk_idx   INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  embedding   BLOB,
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     TEXT NOT NULL DEFAULT 'legacy' REFERENCES users(id),
  UNIQUE(user_id, kind, ref, chunk_idx)
);

-- Copy every row, preserving `id` so the FTS `search` rows (which key on
-- CAST(sources.id AS TEXT)) stay valid after the swap.
INSERT INTO sources_new (id, kind, ref, chunk_idx, title, body, meta, embedding, indexed_at, user_id)
SELECT id, kind, ref, chunk_idx, title, body, meta, embedding, indexed_at, user_id
FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

-- Recreate indexes (0001 + 0002).
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
CREATE INDEX IF NOT EXISTS idx_sources_ref  ON sources(kind, ref);
CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id, kind);

-- Recreate FTS sync triggers (same bodies as 0001/0005 — table shape change only).
CREATE TRIGGER trg_sources_ai
AFTER INSERT ON sources BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body);
END;

CREATE TRIGGER trg_sources_au
AFTER UPDATE ON sources BEGIN
  DELETE FROM search WHERE kind = OLD.kind AND entity_id = CAST(OLD.id AS TEXT);
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body);
END;

CREATE TRIGGER trg_sources_ad
AFTER DELETE ON sources BEGIN
  DELETE FROM search WHERE kind = OLD.kind AND entity_id = CAST(OLD.id AS TEXT);
END;
