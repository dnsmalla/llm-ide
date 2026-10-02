-- Let the `sources` triggers delete their FTS row BY ROWID.
--
-- The 0001 triggers removed the old row with
--   DELETE FROM search WHERE kind = OLD.kind AND entity_id = CAST(OLD.id AS TEXT)
-- and both columns are UNINDEXED in FTS5, so every update/delete of a source
-- scanned the whole virtual table (~13–39 ms per row at 9k rows). A
-- project-open re-ingest replaces thousands of code chunks in one write
-- transaction, so it held the database's only writer for minutes.
--
-- `search_source_rowid` records which FTS row each source wrote (the insert
-- trigger reads last_insert_rowid(), which inside a trigger is the row the
-- trigger itself just inserted). The FTS rowids are left exactly as they are,
-- so the LIKE-only "newest first" order (-rowid) is unchanged.
--
-- Deliberately NOT a rebuild of `search`: re-indexing every row with the
-- trigram tokenizer takes 10–20 s on a real database, synchronously, on the
-- server's first request — past the Mac app's 20 s /health deadline, which
-- then kills and restarts the server mid-migration forever. Instead a source
-- written before this migration has no mapping row and is deleted the old
-- way, once, by the *_legacy BEFORE triggers. Their gate is a trigger WHEN
-- clause on purpose: measured, the same NOT EXISTS as a WHERE term inside
-- the trigger body still scans the table on every row, while a WHEN clause
-- skips the body entirely. BEFORE triggers always fire before AFTER ones, so
-- the slow delete runs before the AFTER trigger inserts the replacement row
-- (which carries the same entity_id). The next re-ingest replaces every
-- legacy row with a mapped one.

CREATE TABLE search_source_rowid (
  source_id    INTEGER PRIMARY KEY,
  search_rowid INTEGER NOT NULL
);

DROP TRIGGER IF EXISTS trg_sources_ai;
DROP TRIGGER IF EXISTS trg_sources_au;
DROP TRIGGER IF EXISTS trg_sources_ad;

CREATE TRIGGER trg_sources_bu_legacy
BEFORE UPDATE ON sources
WHEN NOT EXISTS (SELECT 1 FROM search_source_rowid WHERE source_id = OLD.id) BEGIN
  DELETE FROM search WHERE kind = OLD.kind AND entity_id = CAST(OLD.id AS TEXT);
END;

CREATE TRIGGER trg_sources_bd_legacy
BEFORE DELETE ON sources
WHEN NOT EXISTS (SELECT 1 FROM search_source_rowid WHERE source_id = OLD.id) BEGIN
  DELETE FROM search WHERE kind = OLD.kind AND entity_id = CAST(OLD.id AS TEXT);
END;

CREATE TRIGGER trg_sources_ai
AFTER INSERT ON sources BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body);
  INSERT OR REPLACE INTO search_source_rowid (source_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;

CREATE TRIGGER trg_sources_au
AFTER UPDATE ON sources BEGIN
  DELETE FROM search
   WHERE rowid = (SELECT search_rowid FROM search_source_rowid WHERE source_id = OLD.id);
  DELETE FROM search_source_rowid WHERE source_id = OLD.id;
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body);
  INSERT OR REPLACE INTO search_source_rowid (source_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;

CREATE TRIGGER trg_sources_ad
AFTER DELETE ON sources BEGIN
  DELETE FROM search
   WHERE rowid = (SELECT search_rowid FROM search_source_rowid WHERE source_id = OLD.id);
  DELETE FROM search_source_rowid WHERE source_id = OLD.id;
END;
