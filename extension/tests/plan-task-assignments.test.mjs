// Plan-task assignment to a project member (migration 0075, API 130).
//
// Store-level and handler-level: assigning / reassigning / unassigning, the project rules (an
// assignee must be an effective project member; assigning someone else needs project admin/owner;
// a member may claim an unassigned task), the cross-project refusal, my-assignments scoping, the
// project task board, re-plan preservation, audit rows and the in-app notification row.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-plan-assign-'));
const tmpDb = path.join(root, 'kb.db');
process.env.LLMIDE_DB_PATH = tmpDb;
process.env.LLMIDE_DATA_DIR = root;

const { getDb, closeDb } = await import('../kb/db.mjs');
const { registerProject, setProjectMember, removeProjectMember } = await import('../kb/projects.mjs');
const { savePlan } = await import('../kb/plans.mjs');
const {
  assignPlanTask, unassignPlanTask, listMyAssignments, listProjectPlanTasks,
  getTaskAssignment,
} = await import('../kb/plan-assignments.mjs');
const { handlePlanningRoutes } = await import('../routes/planning.mjs');
const { handleProjectRoute } = await import('../routes/project-routes.mjs');
const { listActivity, ACTIVITY_KINDS } = await import('../kb/activity.mjs');
const { closeAgentDb } = await import('../kb/agent-db.mjs');
const { grant } = await import('./helpers/grant.mjs');

const db = () => getDb();
const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

after(() => {
  try { closeAgentDb(); } catch { /* closed */ }
  try { closeDb(); } catch { /* closed */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
function user(email, teamRole = 'member', maxMode = 'execute', usdCapMonth = 0) {
  const id = `a-${++seq}`;
  db().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')",
  ).run(id, email, email.split('@')[0]);
  grant(db(), id, { teamRole, maxMode, usdCapMonth });
  return id;
}

const owner = user('owner@example.com', 'owner');
const engineer = user('eng@example.com', 'member');
const engineer2 = user('eng2@example.com', 'member');
const outsider = user('outsider@example.com', 'member');
const viewer = user('viewer@example.com', 'viewer');

registerProject(db(), owner, { id: 'p-one', name: 'One', root: path.join(root, 'one') });
registerProject(db(), owner, { id: 'p-two', name: 'Two', root: path.join(root, 'two') });
setProjectMember(db(), owner, 'p-one', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
setProjectMember(db(), owner, 'p-one', engineer2, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
setProjectMember(db(), owner, 'p-two', outsider, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
// A team viewer with a project owner row is still a viewer (H1.2) and may not be assigned.
setProjectMember(db(), owner, 'p-one', viewer, { role: 'owner', maxMode: 'execute', usdCapMonth: 0 });

const tasksFor = (ids) => ids.map((id) => ({ id, title: `Task ${id}` }));
const planOne = savePlan(owner, {
  id: 'plan-one', title: 'One plan', meta: { projectId: 'p-one' },
  tasks: tasksFor(['t-1', 't-2', 't-3']),
});
savePlan(owner, {
  id: 'plan-two', title: 'Two plan', meta: { projectId: 'p-two' },
  tasks: tasksFor(['u-1']),
});
assert.equal(planOne.tasks.length, 3);

// ── assign / reassign / unassign ────────────────────────────────────────────

test('a project admin assigns, reassigns and unassigns; the log records each transition', () => {
  const first = assignPlanTask(db(), owner, 't-1', engineer);
  assert.equal(first.changed, true);
  assert.equal(first.action, 'assign');
  assert.equal(first.assignment.assignee.userId, engineer);
  assert.equal(getTaskAssignment(db(), 't-1').assignee.userId, engineer);

  const again = assignPlanTask(db(), owner, 't-1', engineer);
  assert.equal(again.changed, false, 'assigning the same member is idempotent');
  assert.equal(again.action, null);

  const moved = assignPlanTask(db(), owner, 't-1', engineer2);
  assert.equal(moved.changed, true);
  assert.equal(moved.action, 'reassign');
  assert.equal(moved.assignment.assignee.userId, engineer2);

  const cleared = unassignPlanTask(db(), owner, 't-1');
  assert.deepEqual(cleared, { unassigned: true, taskId: 't-1' });
  assert.equal(getTaskAssignment(db(), 't-1'), null);
  assert.deepEqual(unassignPlanTask(db(), owner, 't-1'), { unassigned: false, taskId: 't-1' });

  const log = db().prepare(
    'SELECT action, from_user_id, to_user_id, actor_user_id FROM plan_task_assignment_log WHERE task_id = ? ORDER BY id',
  ).all('t-1');
  assert.deepEqual(log.map((r) => r.action), ['assign', 'reassign', 'unassign']);
  assert.equal(log[0].from_user_id, null);
  assert.equal(log[0].to_user_id, engineer);
  assert.equal(log[1].from_user_id, engineer);
  assert.equal(log[1].to_user_id, engineer2);
  assert.ok(log.every((r) => r.actor_user_id === owner));
});

test('a member may claim an unassigned task themselves and release their own', () => {
  const claimed = assignPlanTask(db(), engineer, 't-2', null);
  assert.equal(claimed.changed, true);
  assert.equal(claimed.assignment.assignee.userId, engineer);
  assert.equal(claimed.assignment.assignedBy.userId, engineer);

  const released = unassignPlanTask(db(), engineer, 't-2');
  assert.equal(released.unassigned, true);
  assert.equal(getTaskAssignment(db(), 't-2'), null);
});

test('a member cannot assign someone else, or take a task from another member', () => {
  assignPlanTask(db(), owner, 't-3', engineer2);
  assert.throws(() => assignPlanTask(db(), engineer, 't-3', engineer), (e) => e.code === 'SELF_CLAIM_DENIED' && e.status === 403);
  assert.throws(() => assignPlanTask(db(), engineer, 't-2', engineer2), (e) => e.code === 'ROLE_DENIED' && e.status === 403);
  unassignPlanTask(db(), owner, 't-3');
});

// ── membership rules ────────────────────────────────────────────────────────

test('an implicit project viewer cannot claim a task', () => {
  assert.throws(() => assignPlanTask(db(), outsider, 't-2', null), (e) => e.code === 'ROLE_DENIED' && e.status === 403);
});

test('a team viewer is refused even with a project owner row (H1.2)', () => {
  assert.throws(() => assignPlanTask(db(), owner, 't-2', viewer), (e) => e.code === 'NOT_PROJECT_MEMBER' && e.status === 403);
});

test('a non-member target is refused, and no assignment or log row is written', () => {
  const before = db().prepare('SELECT COUNT(*) AS n FROM plan_task_assignment_log WHERE task_id = ?').get('t-2').n;
  assert.throws(() => assignPlanTask(db(), owner, 't-2', outsider), (e) => e.code === 'NOT_PROJECT_MEMBER' && e.status === 403);
  assert.equal(getTaskAssignment(db(), 't-2'), null);
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM plan_task_assignment_log WHERE task_id = ?').get('t-2').n, before);
});

test('a member of another project is refused for this project’s task (cross-project)', () => {
  // outsider is a member of p-two only; t-2 belongs to p-one.
  assert.throws(() => assignPlanTask(db(), owner, 't-2', outsider), (e) => e.code === 'NOT_PROJECT_MEMBER');
  // engineer is a member of p-one only; u-1 belongs to p-two.
  assert.throws(() => assignPlanTask(db(), owner, 'u-1', engineer), (e) => e.code === 'NOT_PROJECT_MEMBER');
  assert.equal(getTaskAssignment(db(), 'u-1'), null);
});

test('a plan with no project cannot be assigned', () => {
  savePlan(owner, { id: 'plan-free', title: 'Free', tasks: [{ id: 'free-1', title: 'Free task' }] });
  assert.throws(() => assignPlanTask(db(), owner, 'free-1', engineer), (e) => e.code === 'PROJECT_REQUIRED' && e.status === 400);
});

// ── my assignments ──────────────────────────────────────────────────────────

test('my assignments are scoped to the caller and to projects they still belong to', () => {
  assignPlanTask(db(), owner, 't-1', engineer);
  assignPlanTask(db(), owner, 't-2', engineer2);

  const mine = listMyAssignments(db(), engineer);
  assert.deepEqual(mine.map((r) => r.taskId), ['t-1']);
  assert.equal(mine[0].projectId, 'p-one');
  assert.equal(mine[0].projectName, 'One');
  assert.equal(mine[0].planTitle, 'One plan');
  assert.equal(listMyAssignments(db(), engineer2).map((r) => r.taskId).includes('t-2'), true);
  assert.equal(listMyAssignments(db(), engineer).some((r) => r.taskId === 't-2'), false);

  // A second project's assignment shows in the same list, and the project filter narrows it.
  assignPlanTask(db(), owner, 'u-1', outsider);
  assert.deepEqual(listMyAssignments(db(), outsider).map((r) => r.taskId), ['u-1']);
  assert.deepEqual(listMyAssignments(db(), outsider, { projectId: 'p-two' }).map((r) => r.taskId), ['u-1']);
  assert.deepEqual(listMyAssignments(db(), outsider, { projectId: 'p-one' }), []);

  // Removing the project grant hides the stale row: the caller can no longer act on it.
  removeProjectMember(db(), owner, 'p-one', engineer);
  assert.deepEqual(listMyAssignments(db(), engineer), []);
  // The row itself is retained for the project admin and for the audit log.
  assert.equal(getTaskAssignment(db(), 't-1').assignee.userId, engineer);
  setProjectMember(db(), owner, 'p-one', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
});

test('the project task board lists only that project, with assignees, for a member', () => {
  const board = listProjectPlanTasks(db(), engineer, 'p-one');
  assert.equal(board.project.id, 'p-one');
  assert.deepEqual(board.tasks.map((t) => t.taskId).sort(), ['t-1', 't-2', 't-3']);
  assert.equal(board.tasks.find((t) => t.taskId === 't-1').assignee.userId, engineer);
  assert.equal(board.tasks.find((t) => t.taskId === 't-3').assignee, null);
  assert.equal(board.tasks.some((t) => t.taskId === 'u-1'), false);

  assert.throws(() => listProjectPlanTasks(db(), outsider, 'p-one'), (e) => e.code === 'ROLE_DENIED' && e.status === 403);
  assert.throws(() => listProjectPlanTasks(db(), viewer, 'p-one'), (e) => e.code === 'ROLE_DENIED');
});

// ── re-plan preservation ────────────────────────────────────────────────────

test('savePlan keeps an assignment when the task id survives, and drops it when the project changes', () => {
  savePlan(owner, {
    id: 'plan-one', title: 'One plan', meta: { projectId: 'p-one' },
    tasks: [
      { id: 't-1', title: 'Task t-1 renamed' },
      { id: 't-2', title: 'Task t-2' },
      { id: 't-3', title: 'Task t-3' },
    ],
  });
  assert.equal(getTaskAssignment(db(), 't-1').assignee.userId, engineer, 'surviving id keeps its assignee');

  // A task the re-plan removes loses its assignment.
  savePlan(owner, {
    id: 'plan-one', title: 'One plan', meta: { projectId: 'p-one' },
    tasks: [{ id: 't-1', title: 'Task t-1' }],
  });
  assert.equal(getTaskAssignment(db(), 't-2'), null);

  // Moving the plan to another project drops the old project's grant.
  savePlan(owner, {
    id: 'plan-one', title: 'One plan', meta: { projectId: 'p-two' },
    tasks: [{ id: 't-1', title: 'Task t-1' }],
  });
  assert.equal(getTaskAssignment(db(), 't-1'), null);
  // Restore the fixture for the route tests below.
  savePlan(owner, {
    id: 'plan-one', title: 'One plan', meta: { projectId: 'p-one' },
    tasks: tasksFor(['t-1', 't-2', 't-3']),
  });
});

// ── handler-level: auth, audit, notification ────────────────────────────────

let ip = 0;
function makeReq({ method, url, body, user, headers = {} }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers,
    socket: { remoteAddress: `10.31.0.${++ip}` },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; },
    json() { return JSON.parse(this._body); },
  };
}

async function callPlan(opts) {
  const res = makeRes();
  const handled = await handlePlanningRoutes(makeReq(opts), res, { userId: opts.user.id, url: opts.url });
  return { res, handled };
}

async function callProject(opts) {
  const res = makeRes();
  const handled = await handleProjectRoute(makeReq(opts), res, {
    db: db(), logger: noopLogger, requestId: 'req', dir: path.join(root, 'team'),
  });
  return { res, handled };
}

test('POST /kb/plan-task/assign audits the change and notifies the assignee in-app', async () => {
  const { res, handled } = await callPlan({
    method: 'POST', url: '/kb/plan-task/assign', user: { id: owner },
    body: { taskId: 't-2', userId: engineer },
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().assignment.assignee.userId, engineer);

  const audit = db().prepare(
    "SELECT detail FROM audit_log WHERE action = 'plan.task.assign' ORDER BY id DESC LIMIT 1",
  ).get();
  const detail = JSON.parse(audit.detail);
  assert.equal(detail.projectId, 'p-one');
  assert.equal(detail.toUserId, engineer);
  assert.equal(detail.fromUserId, null);

  const feed = listActivity(engineer, { limit: 10 });
  const notice = feed.find((a) => a.kind === 'task_assigned');
  assert.ok(notice, 'the assignee gets one in-app activity row');
  assert.match(notice.title, /Assigned to you: Task t-2/);
  assert.equal(notice.detail.taskId, 't-2');
  assert.equal(ACTIVITY_KINDS.has('task_assigned'), true);
});

test('POST /kb/plan-task/assign validates the body and refuses a non-member target', async () => {
  const missing = await callPlan({
    method: 'POST', url: '/kb/plan-task/assign', user: { id: owner }, body: { userId: engineer },
  });
  assert.equal(missing.res.statusCode, 400);
  assert.equal(missing.res.json().error.code, 'VALIDATION_FAILED');

  const extra = await callPlan({
    method: 'POST', url: '/kb/plan-task/assign', user: { id: owner },
    body: { taskId: 't-2', userId: engineer, nope: true },
  });
  assert.equal(extra.res.statusCode, 400);

  const denied = await callPlan({
    method: 'POST', url: '/kb/plan-task/assign', user: { id: owner },
    body: { taskId: 't-2', userId: outsider },
  });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.json().error.code, 'NOT_PROJECT_MEMBER');
});

test('POST /kb/plan-task/unassign audits and is idempotent', async () => {
  const ok = await callPlan({
    method: 'POST', url: '/kb/plan-task/unassign', user: { id: owner }, body: { taskId: 't-2' },
  });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.res.json().unassigned, true);
  const audit = db().prepare(
    "SELECT detail FROM audit_log WHERE action = 'plan.task.unassign' ORDER BY id DESC LIMIT 1",
  ).get();
  assert.equal(JSON.parse(audit.detail).fromUserId, engineer);
  const again = await callPlan({
    method: 'POST', url: '/kb/plan-task/unassign', user: { id: owner }, body: { taskId: 't-2' },
  });
  assert.equal(again.res.json().unassigned, false);
});

test('GET /kb/plan-task/assignments is the caller’s own list, across projects', async () => {
  assignPlanTask(db(), owner, 't-1', engineer);
  assignPlanTask(db(), owner, 't-3', engineer);
  assignPlanTask(db(), owner, 'u-1', outsider);
  const { res } = await callPlan({
    method: 'GET', url: '/kb/plan-task/assignments', user: { id: engineer },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.assignments.map((r) => r.taskId).sort(), ['t-1', 't-3']);
  assert.ok(body.assignments.every((r) => r.assignee.userId === engineer));
  assert.equal(body.count, 2);

  const scoped = await callPlan({
    method: 'GET', url: '/kb/plan-task/assignments?projectId=p-two', user: { id: engineer },
  });
  assert.deepEqual(scoped.res.json().assignments, []);
  const other = await callPlan({ method: 'GET', url: '/kb/plan-task/assignments', user: { id: outsider } });
  assert.deepEqual(other.res.json().assignments.map((r) => r.taskId), ['u-1']);
});

test('GET /projects/:id/plan-tasks is a project-member route with the assignee on each row', async () => {
  const ok = await callProject({ method: 'GET', url: '/projects/p-one/plan-tasks', user: { id: engineer } });
  assert.equal(ok.handled, true);
  assert.equal(ok.res.statusCode, 200);
  const body = ok.res.json();
  assert.equal(body.project.id, 'p-one');
  assert.equal(body.tasks.find((t) => t.taskId === 't-1').assignee.userId, engineer);
  assert.equal(body.tasks.find((t) => t.taskId === 't-2').assignee, null);

  const denied = await callProject({ method: 'GET', url: '/projects/p-one/plan-tasks', user: { id: outsider } });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.json().error.code, 'ROLE_DENIED');

  const unknown = await callProject({ method: 'GET', url: '/projects/p-nope/plan-tasks', user: { id: owner } });
  assert.equal(unknown.res.statusCode, 404);
});

test('GET /kb/plan/:id and /kb/plan-task/update expose the assignee without changing owner', async () => {
  const plan = await callPlan({ method: 'GET', url: '/kb/plan/plan-one', user: { id: owner } });
  assert.equal(plan.res.statusCode, 200);
  const task = plan.res.json().tasks.find((t) => t.id === 't-1');
  assert.equal(task.assignee.userId, engineer);
  assert.equal(plan.res.json().projectId, 'p-one');

  const older = savePlan(owner, {
    id: 'plan-owner-text', title: 'Owner text', meta: { projectId: 'p-one' },
    tasks: [{ id: 'own-1', title: 'Owned by planner', owner: 'backend engineer' }],
  });
  assert.equal(older.tasks[0].owner, 'backend engineer');
  assert.equal(older.tasks[0].assignee, null);
});

test('a plan cannot be tagged with a project the author is not a member of', async () => {
  const tag = (u, projectId) => callPlan({
    user: { id: u }, method: 'POST', url: '/kb/plan/save',
    body: { id: `plan-tag-${u}-${projectId}`, title: 'Tagged', meta: { projectId }, tasks: tasksFor(['x-1']) },
  });
  const denied = await tag(outsider, 'p-one');
  assert.equal(denied.res.statusCode, 403);
  assert.ok(!JSON.stringify(listProjectPlanTasks(db(), owner, 'p-one')).includes('plan-tag-'), 'nothing reached the board');
  const ok = await tag(engineer, 'p-one');
  assert.equal(ok.res.statusCode, 200);
});

test('the tagged plan of a member does reach the board (the refusal check above is not vacuous)', () => {
  assert.ok(JSON.stringify(listProjectPlanTasks(db(), owner, 'p-one')).includes('plan-tag-'));
});
