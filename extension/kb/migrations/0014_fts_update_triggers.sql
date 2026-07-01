-- 0014 -- AFTER UPDATE FTS triggers for meetings and plans.
--
-- Without these triggers, re-ingesting a meeting with a changed title or
-- re-saving a plan with a new goal leaves the FTS index pointing at the
-- old text.  Search results become stale.
--
-- Pattern mirrors trg_sources_au (0001/0005) and trg_plan_tasks_au (0001/0011):
-- delete the old search row by (entity_id, kind), then insert the new one.
--
-- meetings: entity_id = meetings.id (NULL in the old pre-Phase-3 row layout),
--           but in practice the INSERT trigger stored meeting_id = NEW.id and
--           entity_id = NULL.  The DELETE path must match what the AI trigger
--           wrote: entity_id IS NULL AND meeting_id = OLD.id AND kind = 'meeting'.
--
-- plans: entity_id = plans.id, kind = 'plan'.

CREATE TRIGGER IF NOT EXISTS trg_meetings_au
AFTER UPDATE ON meetings BEGIN
  DELETE FROM search WHERE meeting_id = OLD.id AND entity_id IS NULL AND kind = 'meeting';
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.id, NULL, 'meeting', NEW.title, COALESCE(NEW.transcript, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_plans_au
AFTER UPDATE ON plans BEGIN
  DELETE FROM search WHERE entity_id = OLD.id AND kind = 'plan';
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (COALESCE(NEW.meeting_id, ''), NEW.id, 'plan', NEW.title, COALESCE(NEW.goal, ''));
END;
