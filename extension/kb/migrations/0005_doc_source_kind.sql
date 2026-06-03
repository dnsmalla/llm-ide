-- 0005 — allow `doc` as a sources.kind value.
--
-- Generated meeting notes / structured docs / DOCX content were
-- previously returned to the client and never written back to KB,
-- meaning future chats had no way to retrieve them.  Adding 'doc' to
-- the sources.kind CHECK constraint lets the same ingestion path
-- (ingestSources + FTS triggers) carry generated content so search
-- and the agent loop can surface it later.
--
-- SQLite has no ALTER COLUMN for CHECK constraints, so the standard
-- recipe is: build a new table, copy rows, swap names, recreate
-- indexes and triggers.  All wrapped in the transaction the migration
-- runner already opens for us.

-- Drop dependent triggers first; they reference the table by name.
DROP TRIGGER IF EXISTS trg_sources_ai;
DROP TRIGGER IF EXISTS trg_sources_au;
DROP TRIGGER IF EXISTS trg_sources_ad;

-- Create the replacement table with the expanded CHECK list.
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
  UNIQUE(kind, ref, chunk_idx)
);

-- Copy every existing row.  Column order matches the old layout
-- (verified against 0001 + 0002).  AUTOINCREMENT ids are preserved
-- because we copy `id` explicitly.
INSERT INTO sources_new (id, kind, ref, chunk_idx, title, body, meta, embedding, indexed_at, user_id)
SELECT id, kind, ref, chunk_idx, title, body, meta, embedding, indexed_at, user_id
FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

-- Recreate indexes that 0001 + 0002 set up.
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
CREATE INDEX IF NOT EXISTS idx_sources_ref  ON sources(kind, ref);
CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id, kind);

-- Recreate FTS sync triggers.  Same bodies as 0001 — the only change
-- here is the table CHECK constraint.
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
