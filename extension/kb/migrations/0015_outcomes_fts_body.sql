-- 0015 -- Fix outcomes FTS triggers: body = '' instead of raw meta JSON.
--
-- The original trg_outcomes_ai (0001) indexed NEW.meta (raw JSON) as the FTS
-- body field.  This bloats the FTS index with non-human-readable JSON, and
-- differs from every other entity pattern where body carries readable prose or
-- is left empty when there is none.  title already carries state + ref which
-- is the only human-meaningful summary of an outcome.
--
-- We DROP and recreate trg_outcomes_ai with body = '' to match the entities
-- pattern (trg_sources_ai, trg_plan_tasks_ai).  We also add trg_outcomes_au
-- (an update trigger that was missing alongside trg_outcomes_ai) to keep the
-- FTS index consistent if outcome state is updated in place.

DROP TRIGGER IF EXISTS trg_outcomes_ai;

CREATE TRIGGER trg_outcomes_ai
AFTER INSERT ON outcomes BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.task_id, CAST(NEW.id AS TEXT), 'outcome',
          NEW.state || ' -- ' || NEW.ref,
          '');
END;

CREATE TRIGGER IF NOT EXISTS trg_outcomes_au
AFTER UPDATE ON outcomes BEGIN
  DELETE FROM search WHERE entity_id = CAST(OLD.id AS TEXT) AND kind = 'outcome';
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.task_id, CAST(NEW.id AS TEXT), 'outcome',
          NEW.state || ' -- ' || NEW.ref,
          '');
END;
