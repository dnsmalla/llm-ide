-- live-then-archive, server foundations (docs/superpowers/plans/2026-10-29-live-then-archive.md,
-- Phase 1, T1.1). Additive only: nothing reads or writes these yet, and every
-- existing column and row keeps its meaning.

-- 1. note_index: a DERIVED, rebuildable index of the Mac app's meeting notes.
--    It holds no unique data: every column is recomputable from the Mac file
--    (note_key, title, date, duration, participants, project) or is a redacted
--    copy of it (body_text, capped by kb/note-index.mjs). A hidden note is never
--    written here (the Mac does not feed it; the route refuses it).
CREATE TABLE note_index (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL DEFAULT '',
  note_key     TEXT NOT NULL,            -- relative path under the project root, forward slashes
  kind         TEXT NOT NULL DEFAULT 'meeting',
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,            -- note start, ISO
  duration_sec INTEGER NOT NULL DEFAULT 0,
  participants TEXT NOT NULL DEFAULT '[]',
  body_text    TEXT NOT NULL DEFAULT '', -- redacted at build, capped at 200 KB
  content_hash TEXT NOT NULL,            -- SHA-256 of the Mac file bytes
  mtime_ms     INTEGER NOT NULL,
  meta         TEXT NOT NULL DEFAULT '{}',
  indexed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, project_id, note_key)
);
CREATE INDEX idx_note_index_user_date ON note_index(user_id, date DESC);

-- FTS rides the shared `search` table. Note rows carry kind 'note' (every
-- kind-filtered query in kb/db.mjs excludes it unless asked for) and the
-- meeting_id '\u0001note:<id>', a prefix that /kb/ingest and ingestMeeting
-- refuse (control characters). A client meeting id can therefore never name a
-- note row, so a meeting delete cannot remove another user's note FTS row.
-- The update and delete triggers find the old FTS row BY ROWID through this
-- map, never by `meeting_id` (UNINDEXED: a scan of the whole virtual table,
-- measured 55 ms p50 per 20 KB update at 50k rows, F12). Same pattern as 0037.
-- WARNING for every later migration: a migration that rebuilds the `search`
-- table (renumbering its rowids, as 0033 did) MUST call
-- rebuildNoteIndexSearch(db) from kb/note-index.mjs, or the map below points at
-- other rows. indexStatus() reports consistent:false until it is called.
CREATE TABLE note_index_search (
  note_id      INTEGER PRIMARY KEY,
  search_rowid INTEGER NOT NULL
);

CREATE TRIGGER trg_note_index_ai
AFTER INSERT ON note_index BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (char(1) || 'note:' || NEW.id, NULL, 'note', NEW.title, NEW.body_text);
  INSERT OR REPLACE INTO note_index_search (note_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;

CREATE TRIGGER trg_note_index_au
AFTER UPDATE ON note_index BEGIN
  DELETE FROM search
   WHERE rowid = (SELECT search_rowid FROM note_index_search WHERE note_id = OLD.id);
  DELETE FROM note_index_search WHERE note_id = OLD.id;
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (char(1) || 'note:' || NEW.id, NULL, 'note', NEW.title, NEW.body_text);
  INSERT OR REPLACE INTO note_index_search (note_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;

CREATE TRIGGER trg_note_index_ad
AFTER DELETE ON note_index BEGIN
  DELETE FROM search
   WHERE rowid = (SELECT search_rowid FROM note_index_search WHERE note_id = OLD.id);
  DELETE FROM note_index_search WHERE note_id = OLD.id;
END;

-- 2. chat_sessions: additive lifecycle columns for the extension's live chat
--    rows (plan 3.3). Defaults make every existing row a valid live session.
--    meeting_id is the meeting-attached chat tag (Q3); owner_user_id is the
--    Mac-file owner tag reserved for the archive (C16); origin records which
--    client created the row. lifecycle/fence/archive_since drive the fenced
--    archive protocol (begin bumps fence, commit must present it).
ALTER TABLE chat_sessions ADD COLUMN meeting_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN owner_user_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'extension';
ALTER TABLE chat_sessions ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'live';
ALTER TABLE chat_sessions ADD COLUMN fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN archive_since TEXT;

-- 3. pending_session_purges: delete-everywhere tombstones (plan 3.5). Mirrors
--    pending_agent_purges (0049). The owner column is owner_user_id, not
--    user_id, so the user-delete enumerator does not treat a tombstone as the
--    deleted user's data.
CREATE TABLE pending_session_purges (
  deleted_chat_id TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT 'user_delete',  -- user_delete | meeting_end
  attempts        INTEGER NOT NULL DEFAULT 0,
  requested_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (deleted_chat_id, owner_user_id)
);

-- 4. live_acks: the Mac's acknowledgement that a finalized extension meeting is
--    in a verified file (plan 3.6 B). Ids and hashes only, no transcript. Kept
--    so a restarted server still answers "acked" and the extension can release
--    its draft. Owner column is owner_user_id for the same reason as above.
CREATE TABLE live_acks (
  session_id    TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  note_key      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  lines         INTEGER NOT NULL DEFAULT 0,
  acked_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_user_id, session_id)
);
