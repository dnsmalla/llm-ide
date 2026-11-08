-- 0072: partition full-text search by user (C4).
--
-- `search` is one FTS5 table shared by every tenant; search() ranked all rows and then kept the caller's own
-- within a 10,000-row window, so on a hub a member's older hits vanished behind other members' rows. FTS5 tables
-- cannot be ALTERed, so the table is rebuilt (0033's pattern: a temp copy, DROP, CREATE, copy back -- triggers
-- resolve `search` by name when they fire) with an owner column. `user_id` is UNINDEXED: it filters without
-- changing the ranked terms. Rows whose owner cannot be resolved stay NULL and are never returned (fail closed).
-- The two rowid maps are rebuilt because a new FTS table renumbers rowids.

CREATE TEMP TABLE search_copy AS
  SELECT s.meeting_id, s.entity_id, s.kind, s.title, s.body,
    CASE s.kind
      WHEN 'meeting'  THEN (SELECT m.user_id FROM meetings m WHERE m.id = s.meeting_id)
      WHEN 'action'   THEN (SELECT e.user_id FROM entities e WHERE e.id = s.entity_id)
      WHEN 'decision' THEN (SELECT e.user_id FROM entities e WHERE e.id = s.entity_id)
      WHEN 'blocker'  THEN (SELECT e.user_id FROM entities e WHERE e.id = s.entity_id)
      WHEN 'plan'     THEN (SELECT p.user_id FROM plans p WHERE p.id = s.entity_id)
      WHEN 'task'     THEN (SELECT p.user_id FROM plans p WHERE p.id = s.meeting_id)
      WHEN 'outcome'  THEN (SELECT o.user_id FROM outcomes o WHERE o.id = CAST(s.entity_id AS INTEGER))
      WHEN 'note'     THEN (SELECT n.user_id FROM note_index n WHERE n.id = CAST(substr(s.meeting_id, 7) AS INTEGER))
      ELSE (SELECT src.user_id FROM sources src WHERE src.id = CAST(s.entity_id AS INTEGER) AND src.kind = s.kind)
    END AS user_id
  FROM search s;

DROP TABLE search;

CREATE VIRTUAL TABLE search USING fts5(
  meeting_id UNINDEXED,
  entity_id  UNINDEXED,
  kind       UNINDEXED,
  title,
  body,
  user_id    UNINDEXED,
  tokenize = 'trigram remove_diacritics 1'
);

INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  SELECT meeting_id, entity_id, kind, title, body, user_id FROM search_copy;

DROP TABLE search_copy;

-- The rowids changed: rebuild both maps from the new rows.
DELETE FROM note_index_search;
INSERT INTO note_index_search (note_id, search_rowid)
SELECT n.id, s.rowid FROM note_index n
  JOIN search s ON s.kind = 'note' AND n.id = CAST(substr(s.meeting_id, 7) AS INTEGER);

DELETE FROM search_source_rowid;
INSERT INTO search_source_rowid (source_id, search_rowid)
SELECT CAST(s.entity_id AS INTEGER), s.rowid FROM search s
 WHERE s.kind IN ('code', 'ticket', 'qa', 'doc') AND s.entity_id IS NOT NULL;

-- The writers must stamp the owner. Delete triggers are unchanged; the insert/update bodies are recreated with
-- `user_id` (the trigger name stays, so no other schema change is needed).
DROP TRIGGER IF EXISTS trg_meetings_ai;
CREATE TRIGGER trg_meetings_ai AFTER INSERT ON meetings BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.id, NULL, 'meeting', NEW.title, COALESCE(NEW.transcript, ''), NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_meetings_au;
CREATE TRIGGER trg_meetings_au AFTER UPDATE ON meetings BEGIN
  DELETE FROM search WHERE meeting_id = OLD.id AND entity_id IS NULL AND kind = 'meeting';
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.id, NULL, 'meeting', NEW.title, COALESCE(NEW.transcript, ''), NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_entities_ai;
CREATE TRIGGER trg_entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.meeting_id, NEW.id, NEW.kind, NEW.text, COALESCE(NEW.quote, ''), NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_plans_ai;
CREATE TRIGGER trg_plans_ai AFTER INSERT ON plans BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (COALESCE(NEW.meeting_id, ''), NEW.id, 'plan', NEW.title, COALESCE(NEW.goal, ''), NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_plans_au;
CREATE TRIGGER trg_plans_au AFTER UPDATE ON plans BEGIN
  DELETE FROM search WHERE entity_id = OLD.id AND kind = 'plan';
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (COALESCE(NEW.meeting_id, ''), NEW.id, 'plan', NEW.title, COALESCE(NEW.goal, ''), NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_outcomes_ai;
CREATE TRIGGER trg_outcomes_ai AFTER INSERT ON outcomes BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.task_id, CAST(NEW.id AS TEXT), 'outcome', NEW.state || ' -- ' || NEW.ref, '', NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_outcomes_au;
CREATE TRIGGER trg_outcomes_au AFTER UPDATE ON outcomes BEGIN
  DELETE FROM search WHERE entity_id = CAST(OLD.id AS TEXT) AND kind = 'outcome';
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.task_id, CAST(NEW.id AS TEXT), 'outcome', NEW.state || ' -- ' || NEW.ref, '', NEW.user_id);
END;
DROP TRIGGER IF EXISTS trg_plan_tasks_ai;
CREATE TRIGGER trg_plan_tasks_ai AFTER INSERT ON plan_tasks BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.plan_id, NEW.id, 'task', NEW.title, COALESCE(NEW.description, ''),
          (SELECT user_id FROM plans WHERE id = NEW.plan_id));
END;
DROP TRIGGER IF EXISTS trg_plan_tasks_au;
CREATE TRIGGER trg_plan_tasks_au AFTER UPDATE ON plan_tasks BEGIN
  DELETE FROM search WHERE entity_id = OLD.id AND kind = 'task';
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.plan_id, NEW.id, 'task', NEW.title, COALESCE(NEW.description, ''),
          (SELECT user_id FROM plans WHERE id = NEW.plan_id));
END;
DROP TRIGGER IF EXISTS trg_sources_ai;
CREATE TRIGGER trg_sources_ai AFTER INSERT ON sources BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body, NEW.user_id);
  INSERT OR REPLACE INTO search_source_rowid (source_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;
DROP TRIGGER IF EXISTS trg_sources_au;
CREATE TRIGGER trg_sources_au AFTER UPDATE ON sources BEGIN
  DELETE FROM search
   WHERE rowid = (SELECT search_rowid FROM search_source_rowid WHERE source_id = OLD.id);
  DELETE FROM search_source_rowid WHERE source_id = OLD.id;
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body, NEW.user_id);
  INSERT OR REPLACE INTO search_source_rowid (source_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;
DROP TRIGGER IF EXISTS trg_note_index_ai;
CREATE TRIGGER trg_note_index_ai AFTER INSERT ON note_index BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (char(1) || 'note:' || NEW.id, NULL, 'note', NEW.title, NEW.body_text, NEW.user_id);
  INSERT OR REPLACE INTO note_index_search (note_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;
DROP TRIGGER IF EXISTS trg_note_index_au;
CREATE TRIGGER trg_note_index_au AFTER UPDATE ON note_index BEGIN
  DELETE FROM search
   WHERE rowid = (SELECT search_rowid FROM note_index_search WHERE note_id = OLD.id);
  DELETE FROM note_index_search WHERE note_id = OLD.id;
  INSERT INTO search (meeting_id, entity_id, kind, title, body, user_id)
  VALUES (char(1) || 'note:' || NEW.id, NULL, 'note', NEW.title, NEW.body_text, NEW.user_id);
  INSERT OR REPLACE INTO note_index_search (note_id, search_rowid)
  VALUES (NEW.id, last_insert_rowid());
END;
