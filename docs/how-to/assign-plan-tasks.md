# Assign plan tasks to project members

Plan tasks can be assigned to a member of the task's project, with an **Assigned to me** list in the
desktop app and an in-app activity entry for the assignee. The wire contract is API 130 in
[api-server](../spec/api-server.md#7s-plan-task-assignment-api-130); project roles are described in
[assign team roles per project](project-roles.md).

`plan_tasks.owner` is **not** the assignee. The planner writes it as free text (a role such as
`backend`, or a person's name), so it is never treated as an account. The real assignment is a row in
`plan_task_assignments` (migration 0075) with a foreign key to `users` and to the task's project, plus
an append-only `plan_task_assignment_log` for reassignment history.

## What counts as a project member

A task belongs to the project its plan is tagged with: `plans.meta.projectId`. The assignee must have
an **effective role of `member` or higher** on that project:

- a project row (`project_members`) with `member`, `admin` or `owner`;
- or a global team owner/admin, who overrides every project.

An implicit viewer, a project `viewer` row, and a global team viewer are all refused. Cross-project
assignments are refused: being a member of project B never makes you assignable in project A. A plan
with no `meta.projectId` cannot be assigned (`400 PROJECT_REQUIRED`) — register the project first.

## Who can assign

| Actor | May assign |
|---|---|
| project admin/owner (or global team owner/admin) | any member of that project (assign, reassign, unassign) |
| project member | a task that is unassigned or already theirs (claim / re-affirm); release their own task |
| project viewer, or a non-member | nothing |

Assigning someone else, or taking a task from another member, needs project admin/owner
(`403 ROLE_DENIED` / `403 SELF_CLAIM_DENIED`).

## Desktop

1. Open **Settings → Team**. The **Assigned to me** card at the top lists your plan tasks across
   every project you still belong to, with each project's name and the plan title.
2. Pick a project. Its **Plan tasks** board lists every task tagged with that project.
   - A project admin/owner gets an **assignee picker** listing the project's explicit members (plus
     **Unassigned**). Choosing a member assigns or reassigns; choosing Unassigned clears it.
   - A project member sees **Assign to me** on an unassigned task and **Release** on their own task.
3. The assignee gets one in-app `task_assigned` activity row (the status-bar bell). This is in-app
   only: no email, no push, and nothing is written to GitHub/GitLab.

## API

All routes need the normal JWT. The route policy admits the caller; the store re-checks the project
grant.

```bash
# My assignments across projects (optionally one project, at most 200)
curl -s "http://127.0.0.1:3456/kb/plan-task/assignments?limit=50" \
  -H "Authorization: Bearer $TOKEN"
# -> { assignments: [{ taskId, planId, projectId, projectName, planTitle, title,
#                      status, due, milestone, owner, assignee, assignedBy, assignedAt }], count }

# My project's plan-task board (project member)
curl -s "http://127.0.0.1:3456/projects/p-123/plan-tasks" \
  -H "Authorization: Bearer $TOKEN"

# Assign someone else (project admin/owner), reassign, then clear
curl -sX POST http://127.0.0.1:3456/kb/plan-task/assign \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"taskId":"t-abc","userId":"user-eng"}'
# -> { assignment: { taskId, planId, projectId, assignee, assignedBy, assignedAt },
#      changed: true, action: "assign" | "reassign" | null }

# Claim an unassigned task yourself (userId omitted or null)
curl -sX POST http://127.0.0.1:3456/kb/plan-task/assign \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"taskId":"t-abc"}'

curl -sX POST http://127.0.0.1:3456/kb/plan-task/unassign \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"taskId":"t-abc"}'
# -> { unassigned: true, taskId }
```

`GET /kb/plan/:id` and `PATCH /kb/plan-task/update` now carry `projectId` on the plan and `assignee`
(`{ userId, displayName, email, assignedAt }` or `null`) on each task. `owner` is unchanged.

## Audit and re-planning

- Every assign/reassign/unassign writes one `plan_task_assignment_log` row (from/to/actor) and one
  `audit_log` row: `plan.task.assign` / `plan.task.unassign`, with `{ planId, projectId, fromUserId,
  toUserId, reassigned, self }` and never a task title or body.
- Re-planning replaces a plan's tasks. An assignment survives when the task id survives **and** the
  plan's project did not change; a removed task, or a plan moved to another project, loses it. The
  assignment log keeps the history.
- Removing a member from a project hides their stale assignments from **Assigned to me** (they can no
  longer act on the task); the row stays for the project admin and the audit trail.

## Follow-up (not implemented)

Pushing the assignee to a GitHub/GitLab issue is **not** part of this feature. It needs provider write
APIs (GitHub issue assignees, GitLab issue assignees), the mapping from a core user to a provider
account, and its own review/guardrail step. Treat it as a separate task.
