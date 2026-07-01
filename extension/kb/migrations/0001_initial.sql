-- 0001 — initial schema (consolidates phases 2 through 8).  PRAGMAs are
-- applied programmatically in db.mjs because they don't survive being
-- run inside a transaction and we want migrations atomic.

CREATE TABLE IF NOT EXISTS meetings (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,           -- ISO 8601
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  language      TEXT,
  participants  TEXT,                    -- JSON array
  transcript    TEXT,                    -- pre-rendered "[Name] text" form
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase-1 entity types share one table; `kind` discriminates.
-- Owners / participants / severity / due / status are all stored in JSON
-- so the schema doesn't churn as we add new entity flavors in Phase 3+.
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('action','decision','blocker')),
  text        TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}', -- JSON: owner, due, status, severity, participants
  quote       TEXT,
  embedding   BLOB,                       -- reserved for Phase 2.5
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_meeting ON entities(meeting_id);
CREATE INDEX IF NOT EXISTS idx_entities_kind    ON entities(kind);

-- FTS5 virtual table powers keyword search across meetings + entities.
-- Triggers below keep it in sync automatically.  We use the `unicode61`
-- tokenizer with diacritic folding so accented characters match their
-- plain forms (helpful for mixed-language transcripts).
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  meeting_id UNINDEXED,
  entity_id  UNINDEXED,
  kind       UNINDEXED,                  -- 'meeting' | 'action' | 'decision' | 'blocker'
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_meetings_ai
AFTER INSERT ON meetings BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.id, NULL, 'meeting', NEW.title, COALESCE(NEW.transcript, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_meetings_ad
AFTER DELETE ON meetings BEGIN
  DELETE FROM search WHERE meeting_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_entities_ai
AFTER INSERT ON entities BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.meeting_id, NEW.id, NEW.kind, NEW.text, COALESCE(NEW.quote, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_entities_ad
AFTER DELETE ON entities BEGIN
  DELETE FROM search WHERE entity_id = OLD.id;
END;

-- Phase 3 — external sources (code chunks, tickets, QA outcomes).
-- Identified by (kind, ref) so re-indexing the same file/issue updates
-- in place rather than appending duplicates.  `meta` is JSON for
-- per-kind extras (commit hash, issue state, test status, etc.).
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('code','ticket','qa')),
  ref         TEXT NOT NULL,                -- file path, issue URL, test name
  chunk_idx   INTEGER NOT NULL DEFAULT 0,   -- 0-based for multi-chunk sources
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  embedding   BLOB,                         -- reserved for Phase 2.5
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, ref, chunk_idx)
);

CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
CREATE INDEX IF NOT EXISTS idx_sources_ref  ON sources(kind, ref);

-- The search FTS table predates Phase 3, so we reuse `meeting_id` as a
-- generic "container id" and `entity_id` as a generic "row id" — both
-- are UNINDEXED scalars in FTS5.  For sources, container == kind and
-- row == sources.id (stringified).
CREATE TRIGGER IF NOT EXISTS trg_sources_ai
AFTER INSERT ON sources BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_sources_au
AFTER UPDATE ON sources BEGIN
  DELETE FROM search WHERE entity_id = CAST(OLD.id AS TEXT) AND kind = OLD.kind;
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.kind, CAST(NEW.id AS TEXT), NEW.kind, NEW.title, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_sources_ad
AFTER DELETE ON sources BEGIN
  DELETE FROM search WHERE entity_id = CAST(OLD.id AS TEXT) AND kind = OLD.kind;
END;

-- Phase 4 — plans + tasks.  A plan is the output of the planning agent
-- run against a meeting (or a manually-created project goal); tasks are
-- its decomposed milestones.  Risks and code-file mappings are stored
-- alongside each task so the UI doesn't have to recompute them on render.
CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,
  meeting_id  TEXT,
  title       TEXT NOT NULL,
  goal        TEXT,
  language    TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  milestone     TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  owner         TEXT,
  due           TEXT,                       -- YYYY-MM-DD
  estimate_days REAL,
  depends_on    TEXT NOT NULL DEFAULT '[]', -- JSON array of task ids
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','in_progress','done','blocked')),
  risk          TEXT
                  CHECK (risk IN ('low','med','high') OR risk IS NULL),
  risk_reason   TEXT,
  files         TEXT NOT NULL DEFAULT '[]', -- JSON array of code refs
  meta          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_status ON plan_tasks(status);

-- FTS coverage for plans + tasks so they show up alongside meetings,
-- entities, and sources in the unified search.
CREATE TRIGGER IF NOT EXISTS trg_plans_ai
AFTER INSERT ON plans BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (COALESCE(NEW.meeting_id, ''), NEW.id, 'plan', NEW.title, COALESCE(NEW.goal, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_plans_ad
AFTER DELETE ON plans BEGIN
  DELETE FROM search WHERE entity_id = OLD.id AND kind = 'plan';
END;

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

-- Phase 6 — review queue.  Every artifact heading toward a real-world
-- side-effect (dispatching tickets, writing code to disk) lands here
-- first with its guardrail report attached.  Decisions are recorded so
-- the loop (Phase 8) can learn from rejection patterns.
CREATE TABLE IF NOT EXISTS review_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('dispatch','codegen-apply')),
  plan_id      TEXT,
  task_id      TEXT,
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL,                -- JSON: original artifact (full)
  guardrails   TEXT NOT NULL DEFAULT '{}',   -- JSON: rule report
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','executed','failed','expired')),
  reviewer_note TEXT,
  result       TEXT,                          -- JSON: result of execution after approval
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_task   ON review_items(task_id);

-- Phase 8 — outcomes.  One row per state-change observed for a dispatched
-- ticket / PR.  We append rather than overwrite so the planner can later
-- see "this kind of task usually takes 14 days from open to merge" or
-- "tasks tagged 'auth' are 3× more likely to be reverted".
CREATE TABLE IF NOT EXISTS outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,                    -- github / backlog / linear
  ref         TEXT NOT NULL,                    -- issue/pr URL
  state       TEXT NOT NULL,                    -- open / closed / merged / cancelled / reverted / unknown
  is_terminal INTEGER NOT NULL DEFAULT 0,
  meta        TEXT NOT NULL DEFAULT '{}',       -- assignee, labels, mergedAt, etc.
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outcomes_task    ON outcomes(task_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_state   ON outcomes(state);

CREATE TRIGGER IF NOT EXISTS trg_outcomes_ai
AFTER INSERT ON outcomes BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES (NEW.task_id, CAST(NEW.id AS TEXT), 'outcome',
          NEW.state || ' — ' || NEW.ref,
          COALESCE(NEW.meta, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_outcomes_ad
AFTER DELETE ON outcomes BEGIN
  DELETE FROM search WHERE entity_id = CAST(OLD.id AS TEXT) AND kind = 'outcome';
END;
