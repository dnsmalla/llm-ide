// Plan-task assignment to a project member (ADR 0022 project roles; migration 0075).
//
// `plan_tasks.owner` is planner-authored TEXT — a role or a name the model wrote — so it is never
// treated as an account. The real assignment is a row in `plan_task_assignments` (one per task) with
// a FK to `users` and to the task's project, plus an append-only `plan_task_assignment_log`.
//
// A task's project is `plans.meta.projectId`. Assignment is a project operation:
//   - a task with no project cannot be assigned (PROJECT_REQUIRED);
//   - the assignee must be an EFFECTIVE project member (role >= member), so an implicit viewer or a
//     team viewer is refused even if a project row exists (H1.2 is not weakened);
//   - assigning someone else needs project admin/owner (or a team owner/admin);
//   - a project member may claim an unassigned task for themselves, or keep an assignment they
//     already hold. Taking a task assigned to someone else is a manager action.
//
// Every multi-step write is one transaction, and every route that calls these helpers also writes an
// `audit_log` row (`plan.task.assign` / `plan.task.unassign`).

import { AppError } from '../core/errors.mjs';
import { atLeast } from './members.mjs';
import {
  canManageProjectGrant, effectiveProjectGrant, getProject,
} from './projects.mjs';

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ASSIGNMENTS = 200;
const MAX_ASSIGNMENTS_LIMIT = 200;

/** Policy: a member may self-assign only when the task is unassigned or already theirs. */
export const SELF_ASSIGN_POLICY = 'unassigned_or_self';

const err = (code, message, status) => new AppError(code, message, { status });

const isTaskId = (v) => typeof v === 'string' && TASK_ID_RE.test(v);
const isUserId = (v) => typeof v === 'string' && USER_ID_RE.test(v);
const isProjectId = (v) => typeof v === 'string' && PROJECT_ID_RE.test(v);

/** The project a plan is tagged with (`plans.meta.projectId`), or null. */
export function projectIdForPlan(db, planId) {
  if (typeof planId !== 'string' || !planId) return null;
  const row = db.prepare(
    "SELECT json_extract(meta, '$.projectId') AS project_id FROM plans WHERE id = ?",
  ).get(String(planId));
  const id = row?.project_id;
  return typeof id === 'string' && id ? id : null;
}

/** The task plus the plan/project it belongs to, or null. Deliberately not user-scoped: a project
 *  admin assigns a task on a plan another project member authored. */
export function getTaskContext(db, taskId) {
  if (!isTaskId(taskId)) return null;
  return db.prepare(`
    SELECT t.id AS task_id, t.plan_id, t.position, t.milestone, t.title, t.description, t.owner,
           t.due, t.estimate_days, t.status, t.risk, t.risk_reason,
           p.title AS plan_title, p.user_id AS plan_owner,
           json_extract(p.meta, '$.projectId') AS project_id
      FROM plan_tasks t
      JOIN plans p ON p.id = t.plan_id
     WHERE t.id = ?
  `).get(String(taskId)) ?? null;
}

function assignmentRow(db, taskId) {
  return db.prepare(`
    SELECT a.task_id, a.plan_id, a.project_id, a.assignee_user_id, a.assigned_by,
           a.assigned_at, a.updated_at,
           u.email AS assignee_email, u.display_name AS assignee_name,
           ab.email AS assigned_by_email, ab.display_name AS assigned_by_name
      FROM plan_task_assignments a
      JOIN users u ON u.id = a.assignee_user_id
      LEFT JOIN users ab ON ab.id = a.assigned_by
     WHERE a.task_id = ?
  `).get(String(taskId)) ?? null;
}

export function assignmentView(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    planId: row.plan_id,
    projectId: row.project_id,
    assignee: {
      userId: row.assignee_user_id,
      displayName: row.assignee_name ?? '',
      email: row.assignee_email ?? '',
    },
    assignedBy: row.assigned_by ? {
      userId: row.assigned_by,
      displayName: row.assigned_by_name ?? '',
      email: row.assigned_by_email ?? '',
    } : null,
    assignedAt: row.assigned_at,
    updatedAt: row.updated_at,
  };
}

/** The current assignment of a task, as the API/UI shape, or null. */
export function getTaskAssignment(db, taskId) {
  return assignmentView(assignmentRow(db, taskId));
}

/**
 * Whether this account may be the assignee of a task in this project. `role >= member` is required:
 * a viewer (implicit, or explicit project viewer) is not a project member for assignment purposes.
 * Returns `{ eligible, reason, role }`; `reason` is a stable code the route turns into a message.
 */
export function assigneeEligibility(db, userId, projectId) {
  if (!isUserId(userId)) return { eligible: false, reason: 'UNKNOWN_ACCOUNT', role: null };
  if (!isProjectId(projectId) || !getProject(db, projectId)) {
    return { eligible: false, reason: 'NOT_A_PROJECT', role: null };
  }
  const account = db.prepare('SELECT id, status FROM users WHERE id = ?').get(String(userId));
  if (!account || account.status !== 'active') return { eligible: false, reason: 'UNKNOWN_ACCOUNT', role: null };
  const grant = effectiveProjectGrant(db, userId, projectId);
  if (!atLeast(grant.role, 'member')) return { eligible: false, reason: 'NOT_PROJECT_MEMBER', role: grant.role };
  return { eligible: true, reason: null, role: grant.role };
}

function requireProjectForTask(db, task) {
  const projectId = task.project_id;
  if (!isProjectId(projectId)) throw err('PROJECT_REQUIRED', 'This plan is not in a project; assign it one first', 400);
  const project = getProject(db, projectId);
  if (!project) throw err('NOT_FOUND', 'Project not found', 404);
  return project;
}

function logAssignment(db, { task, action, fromUserId, toUserId, actorId }) {
  db.prepare(`
    INSERT INTO plan_task_assignment_log
      (task_id, plan_id, project_id, action, from_user_id, to_user_id, actor_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.task_id, task.plan_id, task.project_id, action,
    fromUserId == null ? null : String(fromUserId),
    toUserId == null ? null : String(toUserId),
    actorId == null ? null : String(actorId),
  );
}

/**
 * Assign (or reassign) one task to a project member.
 *
 * `targetUserId === null/undefined` means "assign to me". A caller who is not a project admin/owner
 * may only self-claim an unassigned task (or re-affirm their own assignment); assigning anyone else,
 * or taking a task from someone else, needs project admin/owner.
 *
 * Returns `{ assignment, changed, action }`.
 */
export function assignPlanTask(db, actorId, taskId, targetUserId = null) {
  if (!isUserId(actorId)) throw err('AUTH_REQUIRED', 'Authentication required', 401);
  if (!isTaskId(taskId)) throw err('VALIDATION', 'Invalid task id', 400);
  const explicitTarget = targetUserId !== null && targetUserId !== undefined;
  if (explicitTarget && !isUserId(targetUserId)) throw err('VALIDATION', 'Invalid member id', 400);
  const target = explicitTarget ? String(targetUserId) : String(actorId);

  const task = getTaskContext(db, taskId);
  if (!task) throw err('NOT_FOUND', 'Task not found', 404);
  requireProjectForTask(db, task);

  const actorGrant = effectiveProjectGrant(db, actorId, task.project_id);
  const actorManages = canManageProjectGrant(actorGrant);
  const selfTarget = target === String(actorId);

  if (!selfTarget && !actorManages) {
    throw err('ROLE_DENIED', 'Only a project owner or admin can assign someone else', 403);
  }
  if (selfTarget) {
    const me = assigneeEligibility(db, actorId, task.project_id);
    if (!me.eligible) {
      throw err('ROLE_DENIED', 'You are not a member of this project', 403);
    }
    const current = assignmentRow(db, taskId);
    if (current && String(current.assignee_user_id) !== String(actorId) && !actorManages) {
      throw err('SELF_CLAIM_DENIED', 'This task is assigned to someone else; ask a project admin', 403);
    }
  }

  const eligible = assigneeEligibility(db, target, task.project_id);
  if (!eligible.eligible) {
    throw err('NOT_PROJECT_MEMBER', 'That account is not a member of this project', 403);
  }

  return db.transaction(() => {
    const current = assignmentRow(db, taskId);
    const fromUserId = current?.assignee_user_id ?? null;
    if (current && String(current.assignee_user_id) === target && current.project_id === task.project_id) {
      return { assignment: assignmentView(current), changed: false, action: null };
    }
    db.prepare(`
      INSERT INTO plan_task_assignments
        (task_id, plan_id, project_id, assignee_user_id, assigned_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        project_id = excluded.project_id,
        assignee_user_id = excluded.assignee_user_id,
        assigned_by = excluded.assigned_by,
        assigned_at = datetime('now'),
        updated_at = datetime('now')
    `).run(task.task_id, task.plan_id, task.project_id, target, String(actorId));
    const action = fromUserId === null ? 'assign' : 'reassign';
    logAssignment(db, {
      task, action, fromUserId, toUserId: target, actorId,
    });
    return { assignment: getTaskAssignment(db, taskId), changed: true, action };
  })();
}

/**
 * Remove a task's assignment. A project admin/owner may unassign anyone; the current assignee may
 * release their own task. Idempotent: an unassigned task answers `{ unassigned: false }`.
 */
export function unassignPlanTask(db, actorId, taskId) {
  if (!isUserId(actorId)) throw err('AUTH_REQUIRED', 'Authentication required', 401);
  if (!isTaskId(taskId)) throw err('VALIDATION', 'Invalid task id', 400);
  const task = getTaskContext(db, taskId);
  if (!task) throw err('NOT_FOUND', 'Task not found', 404);
  requireProjectForTask(db, task);

  return db.transaction(() => {
    const current = assignmentRow(db, taskId);
    if (!current) return { unassigned: false, taskId: String(taskId) };
    const isAssignee = String(current.assignee_user_id) === String(actorId);
    const manages = canManageProjectGrant(effectiveProjectGrant(db, actorId, task.project_id));
    if (!isAssignee && !manages) {
      throw err('ROLE_DENIED', 'Only a project owner or admin, or the assignee, can unassign this task', 403);
    }
    db.prepare('DELETE FROM plan_task_assignments WHERE task_id = ?').run(String(taskId));
    logAssignment(db, {
      task, action: 'unassign', fromUserId: current.assignee_user_id, toUserId: null, actorId,
    });
    return { unassigned: true, taskId: String(taskId) };
  })();
}

/** The caller's assignments across projects, newest/soonest first. `projectId` narrows the list. */
export function listMyAssignments(db, userId, { limit = 100, projectId = null } = {}) {
  if (!isUserId(userId)) throw err('AUTH_REQUIRED', 'Authentication required', 401);
  if (projectId !== null && !isProjectId(projectId)) throw err('VALIDATION', 'Invalid project id', 400);
  const cap = Math.max(1, Math.min(MAX_ASSIGNMENTS_LIMIT, Number(limit) || 100));
  // A stale row from a project the caller was removed from is not shown: they can no longer act on
  // that task. A team owner/admin still sees it (they override every project).
  const rows = db.prepare(`
    SELECT a.task_id, a.plan_id, a.project_id, a.assignee_user_id, a.assigned_by,
           a.assigned_at, a.updated_at,
           t.title, t.status, t.due, t.milestone, t.position, t.owner,
           p.title AS plan_title,
           pr.name AS project_name,
           u.email AS assignee_email, u.display_name AS assignee_name,
           ab.email AS assigned_by_email, ab.display_name AS assigned_by_name
      FROM plan_task_assignments a
      JOIN plan_tasks t ON t.id = a.task_id
      JOIN plans p ON p.id = a.plan_id
      JOIN projects pr ON pr.id = a.project_id
      JOIN users u ON u.id = a.assignee_user_id
      LEFT JOIN users ab ON ab.id = a.assigned_by
     WHERE a.assignee_user_id = ?
       AND (? IS NULL OR a.project_id = ?)
       AND (
         EXISTS (SELECT 1 FROM project_members pm
                  WHERE pm.project_id = a.project_id AND pm.user_id = a.assignee_user_id)
         OR EXISTS (SELECT 1 FROM members m
                     WHERE m.user_id = a.assignee_user_id AND m.team_role IN ('owner','admin'))
       )
     ORDER BY CASE t.status
                WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'blocked' THEN 2
                WHEN 'done' THEN 3 ELSE 4 END,
              CASE WHEN t.due IS NULL THEN 1 ELSE 0 END,
              t.due,
              a.updated_at DESC, a.task_id
     LIMIT ?
  `).all(String(userId), projectId, projectId, cap);
  return rows.map((row) => ({
    ...assignmentView(row),
    title: row.title,
    status: row.status,
    due: row.due,
    milestone: row.milestone,
    position: row.position,
    owner: row.owner,
    planTitle: row.plan_title,
    projectName: row.project_name,
  }));
}

/**
 * Every plan task tagged with this project, with its assignee. Requires project member (role >=
 * member): a viewer sees project read content elsewhere, but not the assignment board.
 */
export function listProjectPlanTasks(db, userId, projectId, { limit = MAX_ASSIGNMENTS } = {}) {
  if (!isUserId(userId)) throw err('AUTH_REQUIRED', 'Authentication required', 401);
  if (!isProjectId(projectId)) throw err('VALIDATION', 'Invalid project id', 400);
  const project = getProject(db, projectId);
  if (!project) throw err('NOT_FOUND', 'Project not found', 404);
  const grant = effectiveProjectGrant(db, userId, projectId);
  if (!atLeast(grant.role, 'member')) {
    throw err('ROLE_DENIED', 'Requires project membership', 403);
  }
  const cap = Math.max(1, Math.min(MAX_ASSIGNMENTS_LIMIT, Number(limit) || MAX_ASSIGNMENTS));
  const rows = db.prepare(`
    SELECT t.id AS task_id, t.plan_id, t.position, t.milestone, t.title, t.description, t.owner,
           t.due, t.estimate_days, t.status, t.risk, t.risk_reason,
           p.title AS plan_title,
           a.project_id, a.assignee_user_id, a.assigned_by, a.assigned_at, a.updated_at,
           u.email AS assignee_email, u.display_name AS assignee_name,
           ab.email AS assigned_by_email, ab.display_name AS assigned_by_name
      FROM plan_tasks t
      JOIN plans p ON p.id = t.plan_id
      LEFT JOIN plan_task_assignments a ON a.task_id = t.id
      LEFT JOIN users u ON u.id = a.assignee_user_id
      LEFT JOIN users ab ON ab.id = a.assigned_by
     WHERE json_extract(p.meta, '$.projectId') = ?
     ORDER BY p.updated_at DESC, t.position, t.id
     LIMIT ?
  `).all(projectId, cap);
  return {
    project: { id: project.id, name: project.name },
    tasks: rows.map((row) => ({
      taskId: row.task_id,
      planId: row.plan_id,
      planTitle: row.plan_title,
      projectId,
      position: row.position,
      milestone: row.milestone,
      title: row.title,
      description: row.description,
      owner: row.owner,
      due: row.due,
      estimateDays: row.estimate_days,
      status: row.status,
      risk: row.risk,
      riskReason: row.risk_reason,
      assignee: row.assignee_user_id ? {
        userId: row.assignee_user_id,
        displayName: row.assignee_name ?? '',
        email: row.assignee_email ?? '',
      } : null,
      assignedBy: row.assigned_by ? {
        userId: row.assigned_by,
        displayName: row.assigned_by_name ?? '',
        email: row.assigned_by_email ?? '',
      } : null,
      assignedAt: row.assigned_at ?? null,
    })),
  };
}

/** Restore the assignments a re-plan should keep (called inside `savePlan`'s transaction). */
export function restoreAssignmentsForPlan(db, planId, { taskIds, projectId, previous }) {
  if (!Array.isArray(previous) || previous.length === 0) return 0;
  const keep = new Set(taskIds.map(String));
  let restored = 0;
  for (const row of previous) {
    if (!keep.has(String(row.task_id))) continue;
    // A plan moved to another project cannot keep a grant that belonged to the old one.
    if (String(row.project_id) !== String(projectId ?? '')) continue;
    db.prepare(`
      INSERT OR IGNORE INTO plan_task_assignments
        (task_id, plan_id, project_id, assignee_user_id, assigned_by, assigned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.task_id, planId, row.project_id, row.assignee_user_id,
      row.assigned_by ?? null, row.assigned_at, row.updated_at,
    );
    restored += 1;
  }
  return restored;
}
