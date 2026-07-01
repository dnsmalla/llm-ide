-- 1. Add 'cancelled' to the plan_tasks status CHECK constraint.
--    The JS layer (plans.mjs ALLOWED_TASK_STATUS) already permits 'cancelled'
--    but the DB CHECK in 0001_initial only covers the original four values.
--    SQLite does not support DROP CONSTRAINT, so we recreate the table.
--
-- 2. Add partial indexes on json_extract() columns used by the outcome
--    watcher hot-path.  Without them every poll scans the full plan_tasks
--    table; with them SQLite uses the index to jump straight to dispatched
--    rows.

-- ── Part 1: Fix plan_tasks status constraint ──────────────────────────────

-- Step A: copy existing rows into a staging table with the new CHECK.
CREATE TABLE plan_tasks_new (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  milestone     TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  owner         TEXT,
  due           TEXT,
  estimate_days REAL,
  depends_on    TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','in_progress','done','blocked','cancelled')),
  risk          TEXT
                  CHECK (risk IN ('low','med','high') OR risk IS NULL),
  risk_reason   TEXT,
  files         TEXT NOT NULL DEFAULT '[]',
  meta          TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO plan_tasks_new SELECT * FROM plan_tasks;

-- Step B: swap tables.
DROP TABLE plan_tasks;
ALTER TABLE plan_tasks_new RENAME TO plan_tasks;

-- Step C: recreate indexes that existed on the old table.
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan   ON plan_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_status ON plan_tasks(status);

-- Recreate triggers that referenced plan_tasks.
CREATE TRIGGER IF NOT EXISTS trg_plan_tasks_ai
AFTER INSERT ON plan_tasks BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.plan_id, NEW.id, 'task', NEW.title, COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_tasks_au
AFTER UPDATE ON plan_tasks BEGIN
  DELETE FROM search WHERE entity_id = OLD.id AND kind = 'task';
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.plan_id, NEW.id, 'task', NEW.title, COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_tasks_ad
AFTER DELETE ON plan_tasks BEGIN
  DELETE FROM search WHERE entity_id = OLD.id AND kind = 'task';
END;

-- ── Part 2: JSON expression indexes for outcome-watcher hot-path ──────────

-- Outcome watcher polls dispatched tasks; this index makes the scan O(dispatched) not O(all).
CREATE INDEX IF NOT EXISTS idx_plan_tasks_dispatched
  ON plan_tasks(user_id)
  WHERE json_extract(meta, '$.dispatched.url') IS NOT NULL;

-- Retry-poller index — tasks with a pending retry timestamp.
CREATE INDEX IF NOT EXISTS idx_plan_tasks_dispatch_retry
  ON plan_tasks(user_id)
  WHERE json_extract(meta, '$.dispatchRetry.nextRetryAt') IS NOT NULL;

-- Project-scoped export index on meetings.
CREATE INDEX IF NOT EXISTS idx_meetings_project
  ON meetings(user_id)
  WHERE json_extract(meta, '$.projectId') IS NOT NULL;

-- Project-scoped export index on plans.
CREATE INDEX IF NOT EXISTS idx_plans_project
  ON plans(user_id)
  WHERE json_extract(meta, '$.projectId') IS NOT NULL;
