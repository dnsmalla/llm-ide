-- 0075: assign a plan task to a project member, and keep the assignment history.
--
-- `plan_tasks.owner` is plan-authored TEXT (the planner writes a role or a name), so it is not a
-- user reference and must not be coerced into one. The current assignment lives in its own table,
-- one row per task, with a real FK to `users` and to the task's project:
--
--   plan_task_assignments      the current assignment (at most one per task)
--   plan_task_assignment_log   append-only history of every assign / reassign / unassign
--
-- The project is denormalised onto both rows because a plan's project is carried in
-- `plans.meta.projectId`, and the assignee must be a member of THAT project. Route-level and
-- store-level checks enforce membership; these FK/CHECK constraints make an orphaned assignment
-- (deleted task, plan, project or account) impossible rather than a stale row a reader must clean up.
--
-- Re-planning (`savePlan`) replaces a plan's tasks wholesale. Assignments survive when the task id
-- survives and the plan's project did not change; the save path restores them in the same
-- transaction. A task that disappears loses its assignment, which the log keeps visible.
CREATE TABLE IF NOT EXISTS plan_task_assignments (
  task_id          TEXT PRIMARY KEY REFERENCES plan_tasks(id) ON DELETE CASCADE,
  plan_id          TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assignee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_task_assignments_assignee
  ON plan_task_assignments(assignee_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_task_assignments_project
  ON plan_task_assignments(project_id, updated_at DESC);

-- Historical rows deliberately carry no FK: a deleted task/plan/project must not erase who was assigned
-- to what. `action` is the transition that happened, so 'reassign' is distinguishable from a first assign.
CREATE TABLE IF NOT EXISTS plan_task_assignment_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('assign','reassign','unassign')),
  from_user_id  TEXT,
  to_user_id    TEXT,
  actor_user_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_task_assignment_log_task
  ON plan_task_assignment_log(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_plan_task_assignment_log_project
  ON plan_task_assignment_log(project_id, id DESC);
