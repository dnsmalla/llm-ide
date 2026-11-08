// Project-scoped team roles (ADR 0021 H1.3): the pure role matrix, the implicit viewer default,
// per-project differences, the global owner/admin override, registration and membership CRUD,
// migration 0070, and the permissions a UI/Host API client displays.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-projects-'));
const tmpDb = path.join(root, 'kb.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const kb = await import('../kb/db.mjs');
const projects = await import('../kb/projects.mjs');
const { grant } = await import('./helpers/grant.mjs');

const {
  PROJECT_ROLE_ORDER, computeProjectGrant, tighterMode, tighterUsdCap, projectPermissions,
  canManageProjectGrant, registerProject, getProject, getProjectMember, effectiveProjectGrant,
  canManageProject, listProjectsForUser, listProjectMembers, setProjectMember,
  addProjectMemberByEmail, removeProjectMember, listProjectAssignmentRows, projectIdForRoot,
} = projects;

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function user(email, teamRole = 'member', maxMode = 'execute', usdCapMonth = 0) {
  const id = `u-${++seq}`;
  kb.getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')",
  ).run(id, email, email.split('@')[0]);
  grant(kb.getDb(), id, { teamRole, maxMode, usdCapMonth });
  return id;
}

const db = () => kb.getDb();
const code = (c) => (e) => e.code === c;

// ── pure role matrix ──────────────────────────────────────────────────────

test('project role order is viewer < member < admin < owner', () => {
  assert.deepEqual(PROJECT_ROLE_ORDER, { viewer: 0, member: 1, admin: 2, owner: 3 });
});

test('a team owner/admin overrides every project row', () => {
  for (const teamRole of ['owner', 'admin']) {
    const g = computeProjectGrant(
      { teamRole, maxMode: 'execute', usdCapMonth: 0 },
      { role: 'viewer', maxMode: 'none', usdCapMonth: 1 },
    );
    assert.equal(g.role, teamRole);
    assert.equal(g.maxMode, 'execute');
    assert.equal(g.usdCapMonth, 0);
    assert.equal(g.source, 'team');
  }
});

test('a team viewer stays a viewer even with a project owner row (H1.2 is not weakened)', () => {
  const g = computeProjectGrant(
    { teamRole: 'viewer', maxMode: 'execute', usdCapMonth: 50 },
    { role: 'owner', maxMode: 'execute', usdCapMonth: 0 },
  );
  assert.equal(g.role, 'viewer');
  assert.equal(g.maxMode, 'read_only');
  assert.equal(g.source, 'implicit');
  assert.equal(canManageProjectGrant(g), false);
});

test('a team member with no project row is an implicit viewer (read/Ask only)', () => {
  const g = computeProjectGrant({ teamRole: 'member', maxMode: 'execute', usdCapMonth: 20 }, null);
  assert.equal(g.role, 'viewer');
  assert.equal(g.maxMode, 'read_only');
  assert.equal(g.usdCapMonth, 20);
  assert.equal(g.projectRole, null);
  assert.equal(g.source, 'implicit');
});

test('a team member with a project row gets that role; mode and cap are the tighter of both', () => {
  assert.equal(computeProjectGrant(
    { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 },
    { role: 'member', maxMode: 'execute', usdCapMonth: 0 },
  ).role, 'member');
  assert.equal(computeProjectGrant(
    { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 },
    { role: 'admin', maxMode: 'read_only', usdCapMonth: 0 },
  ).role, 'admin');
  const g = computeProjectGrant(
    { teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20 },
    { role: 'admin', maxMode: 'execute', usdCapMonth: 5 },
  );
  assert.equal(g.maxMode, 'read_only');
  assert.equal(g.usdCapMonth, 5);

  assert.equal(tighterMode('none', 'execute'), 'none');
  assert.equal(tighterMode('read_only', 'execute'), 'read_only');
  assert.equal(tighterUsdCap(0, 5), 5);
  assert.equal(tighterUsdCap(5, 0), 5);
  assert.equal(tighterUsdCap(4, 9), 4);
  assert.equal(tighterUsdCap(0, 0), 0);
});

test('permissions: project.admin for a project admin/owner, never the team admin class', () => {
  const viewer = projectPermissions(computeProjectGrant({ teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 }, null));
  assert.deepEqual(viewer, ['self.read', 'self.write', 'model.ask']);

  const projectAdmin = projectPermissions(computeProjectGrant(
    { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 },
    { role: 'admin', maxMode: 'execute', usdCapMonth: 0 },
  ));
  assert.ok(projectAdmin.includes('project.admin'));
  assert.ok(projectAdmin.includes('model.exec'));
  assert.ok(!projectAdmin.includes('admin'), 'project admin is not team admin');

  const teamAdmin = projectPermissions(computeProjectGrant(
    { teamRole: 'admin', maxMode: 'execute', usdCapMonth: 0 }, null,
  ));
  assert.ok(teamAdmin.includes('admin'));
  assert.ok(teamAdmin.includes('project.admin'));
});


test('the full project role matrix: classes per role and run mode', () => {
  const memberGrant = (role, maxMode) => computeProjectGrant(
    { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 },
    { role, maxMode, usdCapMonth: 0 },
  );
  const classes = (g) => new Set(projectPermissions(g));
  const has = (set, ...names) => names.every((n) => set.has(n));
  const not = (set, ...names) => names.every((n) => !set.has(n));

  const implicit = classes(computeProjectGrant({ teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 }, null));
  assert.ok(has(implicit, 'self.read', 'self.write', 'model.ask'));
  assert.ok(not(implicit, 'model.read', 'model.exec', 'fs.read', 'install', 'project.admin', 'admin'));

  const memberRead = classes(memberGrant('member', 'read_only'));
  assert.ok(has(memberRead, 'model.ask', 'model.read', 'fs.read', 'external.read'));
  assert.ok(not(memberRead, 'model.exec', 'fs.write', 'external.write', 'install', 'project.admin', 'admin'));

  const memberExec = classes(memberGrant('member', 'execute'));
  assert.ok(has(memberExec, 'model.ask', 'model.read', 'model.exec', 'fs.read', 'fs.write',
    'external.read', 'external.write', 'install'));
  assert.ok(not(memberExec, 'project.admin', 'admin'));

  const adminRead = classes(memberGrant('admin', 'read_only'));
  assert.ok(has(adminRead, 'project.admin', 'model.read', 'fs.read'));
  assert.ok(not(adminRead, 'model.exec', 'fs.write', 'install', 'admin'));

  const adminExec = classes(memberGrant('admin', 'execute'));
  assert.ok(has(adminExec, 'project.admin', 'model.exec', 'fs.write', 'install'));
  assert.ok(not(adminExec, 'admin'));

  const ownerExec = classes(memberGrant('owner', 'execute'));
  assert.ok(has(ownerExec, 'project.admin', 'model.exec', 'install'));
  assert.ok(not(ownerExec, 'admin'));

  const globalAdmin = classes(computeProjectGrant({ teamRole: 'admin', maxMode: 'execute', usdCapMonth: 0 }, null));
  assert.ok(has(globalAdmin, 'admin', 'project.admin', 'install', 'model.exec'));
});

// ── registration ──────────────────────────────────────────────────────────

test('registering a new project creates the registry row and makes the creator its owner', () => {
  const owner = user('owner@example.com', 'owner');
  const out = registerProject(db(), owner, { id: 'p-alpha', name: 'Alpha', root: '/work/alpha' });
  assert.equal(out.created, true);
  assert.equal(out.project.name, 'Alpha');
  assert.equal(out.project.root, '/work/alpha');
  assert.equal(out.project.created_by, owner);
  const row = getProjectMember(db(), owner, 'p-alpha');
  assert.equal(row.role, 'owner');
  assert.equal(row.maxMode, 'execute');
  assert.equal(row.usdCapMonth, 0);
});

test('re-registering updates the name/root but keeps created_by/created_at; a non-manager is refused', () => {
  const owner = user('own2@example.com', 'owner');
  const engineer = user('eng2@example.com', 'member');
  registerProject(db(), owner, { id: 'p-beta', name: 'Beta', root: '/work/beta' });
  const before = getProject(db(), 'p-beta');
  const updated = registerProject(db(), owner, { id: 'p-beta', name: 'Beta 2', root: '/work/beta2' });
  assert.equal(updated.created, false);
  assert.equal(updated.project.name, 'Beta 2');
  assert.equal(updated.project.root, '/work/beta2');
  assert.equal(updated.project.created_by, before.created_by);
  assert.equal(updated.project.created_at, before.created_at);
  assert.throws(() => registerProject(db(), engineer, { id: 'p-beta', name: 'Hijack' }), code('ROLE_DENIED'));
});

test('a viewer cannot create a project; a read_only engineer cannot either', () => {
  const viewer = user('viewer@example.com', 'viewer');
  const readOnly = user('ro@example.com', 'member', 'read_only');
  assert.throws(() => registerProject(db(), viewer, { id: 'p-viewer', root: '/work/v' }), code('ROLE_DENIED'));
  assert.throws(() => registerProject(db(), readOnly, { id: 'p-ro', root: '/work/r' }), code('ROLE_DENIED'));
});

test('an engineer who creates a project owns that project (and only that one)', () => {
  const engineer = user('maker@example.com', 'member');
  registerProject(db(), engineer, { id: 'p-made', root: '/work/made' });
  assert.equal(getProjectMember(db(), engineer, 'p-made').role, 'owner');
  assert.equal(getProjectMember(db(), engineer, 'p-alpha'), null);
  assert.equal(effectiveProjectGrant(db(), engineer, 'p-alpha').role, 'viewer');
});

test('register validates the id and name', () => {
  const owner = user('val@example.com', 'owner');
  assert.throws(() => registerProject(db(), owner, { id: '../x' }), code('VALIDATION'));
  assert.throws(() => registerProject(db(), owner, { id: 'p-ok', name: '   ' }), code('VALIDATION'));
  assert.throws(() => registerProject(db(), owner, { id: 'p-ok', name: 'x'.repeat(121) }), code('VALIDATION'));
});

// ── list / effective grants ──────────────────────────────────────────────

test('listProjectsForUser reports the effective role per project, including the implicit viewer', () => {
  const admin = user('admin@example.com', 'admin');
  const engineer = user('eng@example.com', 'member', 'execute', 20);
  registerProject(db(), admin, { id: 'p-gamma', name: 'Gamma', root: '/work/gamma' });
  registerProject(db(), admin, { id: 'p-delta', name: 'Delta', root: '/work/delta' });
  setProjectMember(db(), admin, 'p-gamma', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 10 });

  const rows = listProjectsForUser(db(), engineer);
  const gamma = rows.find((p) => p.id === 'p-gamma');
  const delta = rows.find((p) => p.id === 'p-delta');
  assert.equal(gamma.role, 'member');
  assert.equal(gamma.maxMode, 'execute');
  assert.equal(gamma.usdCapMonth, 10);
  assert.ok(gamma.permissions.includes('model.exec'));

  assert.equal(delta.role, 'viewer');
  assert.equal(delta.maxMode, 'read_only');
  assert.ok(!delta.permissions.includes('model.exec'));
  assert.ok(delta.permissions.includes('model.ask'));

  const adminRows = listProjectsForUser(db(), admin);
  assert.ok(adminRows.every((p) => p.role === 'admin'), 'a global admin overrides every project');
});

test('a project admin manages that project but not another project', () => {
  const owner = user('powner@example.com', 'owner');
  const admin = user('padmin@example.com', 'member');
  const outsider = user('outsider@example.com', 'member');
  registerProject(db(), owner, { id: 'p-one', root: '/work/one' });
  registerProject(db(), owner, { id: 'p-two', root: '/work/two' });
  setProjectMember(db(), owner, 'p-one', admin, { role: 'admin', maxMode: 'execute', usdCapMonth: 0 });

  assert.equal(canManageProject(db(), admin, 'p-one'), true);
  assert.equal(canManageProject(db(), admin, 'p-two'), false);
  assert.equal(canManageProject(db(), owner, 'p-two'), true, 'the global owner overrides');
  assert.throws(() => addProjectMemberByEmail(db(), admin, 'p-two', { email: 'outsider@example.com' }), code('ROLE_DENIED'));

  const added = addProjectMemberByEmail(db(), admin, 'p-one', {
    email: 'outsider@example.com', role: 'member', maxMode: 'execute', usdCapMonth: 5,
  });
  assert.equal(added.userId, outsider);
  assert.equal(added.role, 'member');
  assert.equal(listProjectMembers(db(), 'p-one').length, 3);
});

test('membership hierarchy: no self change, no grant above the actor, no touching an owner', () => {
  const owner = user('h-owner@example.com', 'owner');
  const admin = user('h-admin@example.com', 'member');
  const engineer = user('h-eng@example.com', 'member');
  registerProject(db(), owner, { id: 'p-h', root: '/work/h' });
  setProjectMember(db(), owner, 'p-h', admin, { role: 'admin', maxMode: 'execute', usdCapMonth: 0 });
  setProjectMember(db(), owner, 'p-h', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });

  assert.throws(() => setProjectMember(db(), admin, 'p-h', admin, { role: 'owner' }), code('SELF_GRANT'));
  assert.throws(() => setProjectMember(db(), admin, 'p-h', engineer, { role: 'owner' }), code('ROLE_DENIED'));
  assert.throws(() => setProjectMember(db(), admin, 'p-h', owner, { role: 'viewer' }), code('ROLE_DENIED'));
  assert.throws(() => setProjectMember(db(), engineer, 'p-h', engineer, { role: 'admin' }), code('ROLE_DENIED'));
  assert.throws(() => setProjectMember(db(), admin, 'p-h', engineer, { maxMode: 'bypass' }), code('VALIDATION'));
  assert.throws(() => setProjectMember(db(), admin, 'p-h', engineer, { usdCapMonth: -1 }), code('VALIDATION'));
  assert.throws(() => setProjectMember(db(), admin, 'p-h', engineer, {}), code('VALIDATION'));

  const promoted = setProjectMember(db(), admin, 'p-h', engineer, { role: 'admin' });
  assert.equal(promoted.role, 'admin');
});

test('removing a membership returns the member to the implicit viewer default', () => {
  const owner = user('r-owner@example.com', 'owner');
  const engineer = user('r-eng@example.com', 'member');
  registerProject(db(), owner, { id: 'p-r', root: '/work/r' });
  setProjectMember(db(), owner, 'p-r', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
  assert.equal(effectiveProjectGrant(db(), engineer, 'p-r').role, 'member');
  assert.equal(removeProjectMember(db(), owner, 'p-r', engineer), true);
  assert.equal(getProjectMember(db(), engineer, 'p-r'), null);
  assert.equal(effectiveProjectGrant(db(), engineer, 'p-r').role, 'viewer');
  assert.equal(removeProjectMember(db(), owner, 'p-r', engineer), false);
});

test('team.yaml rows list only explicit assignments, with the project name', () => {
  const owner = user('y-owner@example.com', 'owner');
  const engineer = user('y-eng@example.com', 'member');
  registerProject(db(), owner, { id: 'p-y', name: 'Yaml Project', root: '/work/y' });
  setProjectMember(db(), owner, 'p-y', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 7 });
  const rows = listProjectAssignmentRows(db());
  const y = rows.find((r) => r.projectId === 'p-y' && r.email === 'y-eng@example.com');
  assert.deepEqual(y, {
    projectId: 'p-y', projectName: 'Yaml Project', email: 'y-eng@example.com',
    role: 'member', maxMode: 'execute', usdCapMonth: 7,
  });
  const creator = rows.find((r) => r.projectId === 'p-y' && r.email === 'y-owner@example.com');
  assert.equal(creator.role, 'owner', 'the creator owner row is explicit and listed');
});

test('migration 0070 adds the registry, membership and usage project columns', () => {
  const handle = db();
  const tables = handle.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','project_members') ORDER BY name",
  ).all().map((r) => r.name);
  assert.deepEqual(tables, ['project_members', 'projects']);
  const usage = handle.prepare('PRAGMA table_info(usage_ledger)').all().map((r) => r.name);
  assert.ok(usage.includes('project_id'));
  const memberCols = handle.prepare('PRAGMA table_info(project_members)').all().map((r) => r.name);
  for (const col of ['user_id', 'project_id', 'role', 'max_mode', 'usd_cap_month', 'granted_by']) {
    assert.ok(memberCols.includes(col), col);
  }
});

test('a turn can inherit the registered project from its canonical root', () => {
  const owner = user('root@example.com', 'owner');
  registerProject(db(), owner, { id: 'p-root', name: 'Root', root: '/work/root' });
  assert.equal(projectIdForRoot(db(), '/work/root'), 'p-root');
  assert.equal(projectIdForRoot(db(), '/work/other'), null);
  assert.equal(projectIdForRoot(db(), ''), null);
  assert.equal(projectIdForRoot(db(), null), null);
});
