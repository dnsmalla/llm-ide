// team.yaml per-project assignments (ADR 0021 H1.3): strict parse/serialize, one-time generation,
// boot application (including the implicit-viewer delete), legacy files that leave project rows alone,
// fail-closed invalid files and the write-through.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-team-yaml-projects-'));
const tmpDb = path.join(root, 'kb.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const kb = await import('../kb/db.mjs');
const projects = await import('../kb/projects.mjs');
const {
  TeamYamlError, applyTeamYaml, parseTeamYaml, parseTeamYamlFile, persistTeamYaml,
  serializeTeamYaml, listTeamProjectAssignments,
} = await import('../kb/team-yaml.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { safeAudit } = await import('../server/route-http.mjs');

const noopLogger = { info() {}, warn() {}, error() {} };
const teamAudit = (entry) => safeAudit(db(), {
  userId: entry.userId ?? null, requestId: 'team.yaml', ip: 'test', userAgent: 'team.yaml',
  action: entry.action, resource: entry.resource ?? null, outcome: entry.outcome ?? 'success',
  detail: { actor: 'team.yaml', ...(entry.detail ?? {}) },
});
let seq = 0;

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(root, { recursive: true, force: true });
});

const db = () => kb.getDb();
const code = (c) => (e) => e instanceof TeamYamlError && e.code === c;
const d = () => {
  const dir = path.join(root, `case-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const write = (dir, text) => fs.writeFileSync(path.join(dir, 'team.yaml'), text, 'utf8');

function user(email, teamRole = 'member', maxMode = 'execute', usdCapMonth = 0) {
  const id = `u-${++seq}`;
  db().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')",
  ).run(id, email, email.split('@')[0]);
  grant(db(), id, { teamRole, maxMode, usdCapMonth });
  return id;
}
const owner = user('owner@example.com', 'owner');
const engineer = user('engineer@example.com', 'member');
const viewer = user('viewer@example.com', 'viewer');

const memberEntry = (email, teamRole = 'member', maxMode = 'execute', usdCapMonth = 0) => [
  `  ${email}:`,
  `    role: ${teamRole}`,
  `    max_mode: ${maxMode}`,
  `    usd_cap_month: ${usdCapMonth}`,
].join('\n');

const fileText = (projectsText) => [
  'members:',
  memberEntry('owner@example.com', 'owner'),
  memberEntry('engineer@example.com', 'member'),
  memberEntry('viewer@example.com', 'viewer'),
  ...(projectsText === null ? [] : ['projects:', projectsText]),
].join('\n');

test('parser reads the members and the optional projects section', () => {
  const parsed = parseTeamYamlFile(fileText([
    '  p-yaml:',
    '    engineer@example.com:',
    '      role: admin',
    '      max_mode: execute',
    '      usd_cap_month: 3',
  ].join('\n')));
  assert.equal(parsed.members.length, 3);
  assert.deepEqual(parsed.projects, [{
    projectId: 'p-yaml',
    members: [{ email: 'engineer@example.com', role: 'admin', maxMode: 'execute', usdCapMonth: 3 }],
  }]);
  assert.deepEqual(parseTeamYaml(fileText(null)).map((a) => a.email),
    ['owner@example.com', 'engineer@example.com', 'viewer@example.com']);
});

test('a legacy file without projects: parses as projects null', () => {
  assert.equal(parseTeamYamlFile(fileText(null)).projects, null);
});

test('serializer round-trips the project section and sorts it', () => {
  const text = serializeTeamYaml([
    { email: 'owner@example.com', teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 },
  ], {
    projects: [
      { projectId: 'p-b', members: [{ email: 'viewer@example.com', role: 'viewer', maxMode: 'read_only', usdCapMonth: 20 }] },
      { projectId: 'p-a', members: [
        { email: 'engineer@example.com', role: 'member', maxMode: 'execute', usdCapMonth: 5 },
        { email: 'owner@example.com', role: 'owner', maxMode: 'execute', usdCapMonth: 0 },
      ] },
    ],
  });
  const parsed = parseTeamYamlFile(text);
  assert.deepEqual(parsed.projects.map((p) => p.projectId), ['p-a', 'p-b']);
  assert.deepEqual(parsed.projects[0].members.map((m) => m.email),
    ['engineer@example.com', 'owner@example.com']);
  assert.equal(parsed.projects[0].members[0].role, 'member');
  assert.match(text, /projects:\n {2}p-a:\n {4}engineer@example\.com:\n {6}role: member/);
});

test('invalid project YAML fails closed with a line', () => {
  const bad = [
    ['unknown project role', '  p-x:\n    engineer@example.com:\n      role: root\n      max_mode: execute\n      usd_cap_month: 0'],
    ['invalid project id', '  ../x:\n    engineer@example.com:\n      role: member\n      max_mode: execute\n      usd_cap_month: 0'],
    ['duplicate project', '  p-x:\n  p-x:'],
    ['duplicate project email', '  p-x:\n    engineer@example.com:\n      role: member\n      max_mode: execute\n      usd_cap_month: 0\n    engineer@example.com:\n      role: admin\n      max_mode: execute\n      usd_cap_month: 0'],
    ['missing project grant', '  p-x:\n    engineer@example.com:\n      role: member'],
    ['invalid project cap', '  p-x:\n    engineer@example.com:\n      role: member\n      max_mode: execute\n      usd_cap_month: -1'],
  ];
  for (const [label, projectsText] of bad) {
    assert.throws(() => parseTeamYamlFile(fileText(projectsText)), code('TEAM_YAML_INVALID'), label);
  }
});

test('boot applies the project section and deletes an omitted row (implicit viewer)', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-boot', name: 'Boot', root: '/work/boot' });
  projects.setProjectMember(db(), owner, 'p-boot', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 4 });
  projects.setProjectMember(db(), owner, 'p-boot', viewer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
  assert.equal(projects.getProjectMember(db(), engineer, 'p-boot').role, 'admin');

  // engineer is admin in the file; viewer is omitted, so the row must go and the grant fall back to viewer.
  write(dir, fileText([
    '  p-boot:',
    '    engineer@example.com:',
    '      role: member',
    '      max_mode: execute',
    '      usd_cap_month: 2',
  ].join('\n')));
  const out = applyTeamYaml(db(), dir, { logger: noopLogger, audit: teamAudit });
  assert.equal(out.projects, 1);
  assert.equal(projects.getProjectMember(db(), engineer, 'p-boot').role, 'member');
  assert.equal(projects.getProjectMember(db(), engineer, 'p-boot').usdCapMonth, 2);
  assert.equal(projects.getProjectMember(db(), viewer, 'p-boot'), null);
  assert.equal(projects.effectiveProjectGrant(db(), viewer, 'p-boot').role, 'viewer');
  assert.ok(out.projectChanges.some((c) => c.userId === engineer && c.to?.role === 'member'));
});

test('a legacy team-level file leaves every project row untouched', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-legacy', name: 'Legacy', root: '/work/legacy' });
  projects.setProjectMember(db(), owner, 'p-legacy', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 0 });
  write(dir, fileText(null));
  const out = applyTeamYaml(db(), dir, { logger: noopLogger, audit: teamAudit });
  assert.equal(out.projects, 0);
  assert.deepEqual(out.projectChanges, []);
  assert.equal(projects.getProjectMember(db(), engineer, 'p-legacy').role, 'admin');
});

test('first boot generates the projects section from the DB; a second boot is idempotent', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-gen', name: 'Generated', root: '/work/gen' });
  projects.setProjectMember(db(), owner, 'p-gen', engineer, { role: 'member', maxMode: 'read_only', usdCapMonth: 6 });
  const first = applyTeamYaml(db(), dir, { logger: noopLogger, audit: teamAudit });
  assert.equal(first.created, true);
  const text = fs.readFileSync(path.join(dir, 'team.yaml'), 'utf8');
  const parsed = parseTeamYamlFile(text);
  const generated = parsed.projects.find((p) => p.projectId === 'p-gen');
  assert.ok(generated, 'the generated file carries the project assignments');
  assert.equal(generated.members.find((m) => m.email === 'engineer@example.com').role, 'member');
  assert.equal(generated.members.find((m) => m.email === 'engineer@example.com').usdCapMonth, 6);
  assert.deepEqual(listTeamProjectAssignments(db()).find((p) => p.projectId === 'p-gen').members
    .map((m) => m.email).sort(), ['engineer@example.com', 'owner@example.com']);

  const second = applyTeamYaml(db(), dir, { logger: noopLogger, audit: teamAudit });
  assert.equal(second.created, false);
  assert.equal(second.projectChanges.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'team.yaml'), 'utf8'), text);
});

test('an unknown project id is ignored and audited, never created', () => {
  const dir = d();
  write(dir, fileText([
    '  p-ghost:',
    '    engineer@example.com:',
    '      role: member',
    '      max_mode: execute',
    '      usd_cap_month: 0',
  ].join('\n')));
  const out = applyTeamYaml(db(), dir, { logger: noopLogger, audit: teamAudit });
  assert.equal(out.projects, 1);
  assert.equal(projects.getProject(db(), 'p-ghost'), null);
  const row = db().prepare("SELECT detail FROM audit_log WHERE action = 'team.yaml.unknown_project' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(row.detail).projectId, 'p-ghost');
});

test('write-through adds/refreshes the projects section from the DB', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-write', name: 'Write', root: '/work/write' });
  projects.setProjectMember(db(), owner, 'p-write', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 9 });
  write(dir, fileText(['  p-write:\n    engineer@example.com:\n      role: viewer\n      max_mode: read_only\n      usd_cap_month: 1'].join('\n')));
  const res = persistTeamYaml(db(), dir, { trigger: 'project.member.patch', audit: teamAudit });
  assert.ok(res.projects >= 1, 'the written file still carries the project section');
  assert.ok(listTeamProjectAssignments(db()).some((p) => p.projectId === 'p-write'));
  const parsed = parseTeamYamlFile(fs.readFileSync(path.join(dir, 'team.yaml'), 'utf8'));
  const block = parsed.projects.find((p) => p.projectId === 'p-write');
  assert.equal(block.members.find((m) => m.email === 'engineer@example.com').role, 'admin');
  assert.equal(block.members.find((m) => m.email === 'engineer@example.com').usdCapMonth, 9);
  const audit = db().prepare("SELECT detail FROM audit_log WHERE action = 'team.yaml.write' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.detail).trigger, 'project.member.patch');
});

test('R-034 #14: a block for one project leaves every other project rows alone', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-keep-a', name: 'Keep A', root: '/work/keep-a' });
  projects.registerProject(db(), owner, { id: 'p-keep-b', name: 'Keep B', root: '/work/keep-b' });
  projects.setProjectMember(db(), owner, 'p-keep-a', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 3 });
  projects.setProjectMember(db(), owner, 'p-keep-b', viewer, { role: 'member', maxMode: 'execute', usdCapMonth: 2 });
  write(dir, fileText([
    '  p-keep-a:',
    '    engineer@example.com:',
    '      role: member',
    '      max_mode: execute',
    '      usd_cap_month: 1',
  ].join('\n')));
  applyTeamYaml(db(), dir, { logger: noopLogger, audit: teamAudit });
  assert.equal(projects.getProjectMember(db(), engineer, 'p-keep-a').maxMode, 'execute');
  assert.equal(projects.getProjectMember(db(), engineer, 'p-keep-a').usdCapMonth, 1);
  assert.equal(projects.getProjectMember(db(), viewer, 'p-keep-b').role, 'member', 'an absent block is not authoritative');
});

test('R-034 #14: write-through preserves a project entry for an email with no account', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-merge', name: 'Merge', root: '/work/merge' });
  projects.setProjectMember(db(), owner, 'p-merge', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 7 });
  write(dir, fileText([
    '  p-merge:',
    '    not-yet-registered@example.com:',
    '      role: member',
    '      max_mode: read_only',
    '      usd_cap_month: 2',
  ].join('\n')));
  persistTeamYaml(db(), dir, { trigger: 'project.member.patch', audit: teamAudit });
  const parsed = parseTeamYamlFile(fs.readFileSync(path.join(dir, 'team.yaml'), 'utf8'));
  const block = parsed.projects.find((p) => p.projectId === 'p-merge');
  assert.equal(block.members.find((m) => m.email === 'engineer@example.com').role, 'admin');
  assert.ok(block.members.some((m) => m.email === 'not-yet-registered@example.com'), 'the unknown-email grant survives the write-through');
});

test('R-034 #14: a project downgrade at boot logs a warning', () => {
  const dir = d();
  projects.registerProject(db(), owner, { id: 'p-warn', name: 'Warn', root: '/work/warn' });
  projects.setProjectMember(db(), owner, 'p-warn', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 5 });
  const warnings = [];
  const logger = { info() {}, warn(action, detail) { warnings.push([action, detail]); }, error() {} };
  write(dir, fileText([
    '  p-warn:',
    '    engineer@example.com:',
    '      role: viewer',
    '      max_mode: read_only',
    '      usd_cap_month: 1',
  ].join('\n')));
  applyTeamYaml(db(), dir, { logger, audit: teamAudit });
  assert.ok(warnings.some(([action]) => action === 'team_yaml_project_downgrade'), 'the narrowing is visible');

  // The registering owner's row is not in the block, so the file leaves the project ownerless.
  assert.ok(warnings.some(([action, detail]) => action === 'team_yaml_project_no_owner' && detail.projectId === 'p-warn'));
});

test('an invalid projects section refuses the boot and changes nothing', () => {
  const dir = d();
  const before = projects.getProjectMember(db(), engineer, 'p-boot');
  write(dir, fileText(['  p-boot:\n    engineer@example.com:\n      role: root\n      max_mode: execute\n      usd_cap_month: 0'].join('\n')));
  assert.throws(() => applyTeamYaml(db(), dir, { logger: noopLogger }), code('TEAM_YAML_INVALID'));
  assert.deepEqual(projects.getProjectMember(db(), engineer, 'p-boot'), before);
});
