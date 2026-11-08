// Host API v1 project scope (ADR 0021 H1.3): projects.list, the per-frame project check, the implicit
// viewer and the no-project backward-compatible path. Gateway wiring is covered by its own test later.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-host-project-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');

const { getDb } = await import('../kb/db.mjs');
const { registerProject, setProjectMember } = await import('../kb/projects.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { projectsListResult, projectFrameAuthority } = await import('../routes/host-api/projects.mjs');

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
function user(email, teamRole = 'member', maxMode = 'execute', usdCapMonth = 0) {
  const id = `h-${++seq}`;
  getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, 'N', 'x', 'user', 'active')",
  ).run(id, email);
  grant(getDb(), id, { teamRole, maxMode, usdCapMonth });
  return id;
}

const owner = user('owner@example.com', 'owner');
const engineer = user('engineer@example.com', 'member');
const outsider = user('outsider@example.com', 'member');
const viewer = user('viewer@example.com', 'viewer');
registerProject(getDb(), owner, { id: 'p-host', name: 'Host', root: '/work/host' });
setProjectMember(getDb(), owner, 'p-host', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });

test('projects.list returns the effective role per project for the device user', () => {
  const out = projectsListResult(getDb(), engineer);
  const p = out.projects.find((x) => x.id === 'p-host');
  assert.equal(p.role, 'member');
  assert.ok(p.permissions.includes('model.exec'));
  const outsiderRow = projectsListResult(getDb(), outsider).projects.find((x) => x.id === 'p-host');
  assert.equal(outsiderRow.role, 'viewer');
  assert.ok(!outsiderRow.permissions.includes('model.exec'));
});

test('an unassigned member is a viewer on a project frame: chat.send is allowed, tool approvals denied', () => {
  const ask = projectFrameAuthority(getDb(), outsider, 'chat.send', { projectId: 'p-host' });
  assert.equal(ask.ok, true);
  assert.equal(ask.scoped, true);
  assert.equal(ask.grant.role, 'viewer');

  const tool = projectFrameAuthority(getDb(), outsider, 'toolApprovals.answer', { projectId: 'p-host' });
  assert.equal(tool.ok, false);
  assert.equal(tool.reason, 'role_denied');

  const exec = projectFrameAuthority(getDb(), outsider, 'toolApprovals.answer', { projectId: 'p-host' });
  assert.equal(exec.ok, false);
  assert.match(exec.reason, /role_denied/);
});

test('a project member executes, a global owner overrides, a global viewer stays Ask only', () => {
  const exec = projectFrameAuthority(getDb(), engineer, 'toolApprovals.answer', { projectId: 'p-host' });
  assert.equal(exec.ok, true);
  assert.equal(exec.grant.role, 'member');

  const override = projectFrameAuthority(getDb(), owner, 'toolApprovals.answer', { projectId: 'p-host' });
  assert.equal(override.ok, true);
  assert.equal(override.grant.source, 'team');

  const viewerAsk = projectFrameAuthority(getDb(), viewer, 'chat.send', { projectId: 'p-host' });
  assert.equal(viewerAsk.ok, true);
  assert.equal(viewerAsk.grant.maxMode, 'read_only');
  const viewerTool = projectFrameAuthority(getDb(), viewer, 'toolApprovals.answer', { projectId: 'p-host' });
  assert.equal(viewerTool.ok, false);
});

test('a read_only project grant refuses tool approvals; the cap refuses once the injected spend reaches it', () => {
  setProjectMember(getDb(), owner, 'p-host', engineer, { role: 'member', maxMode: 'read_only', usdCapMonth: 5 });
  const readOnly = projectFrameAuthority(getDb(), engineer, 'toolApprovals.answer', { projectId: 'p-host' });
  assert.equal(readOnly.ok, false);
  assert.equal(readOnly.reason, 'max_mode_insufficient');

  setProjectMember(getDb(), owner, 'p-host', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 5 });
  const capped = projectFrameAuthority(getDb(), engineer, 'chat.send', { projectId: 'p-host' }, { usedUsd: () => 5 });
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'usd_cap');
  const under = projectFrameAuthority(getDb(), engineer, 'chat.send', { projectId: 'p-host' }, { usedUsd: () => 4.99 });
  assert.equal(under.ok, true);
});

test('an unknown project is refused; a frame without projectId keeps the legacy path', () => {
  assert.equal(projectFrameAuthority(getDb(), engineer, 'chat.send', { projectId: 'p-nope' }).reason, 'not_found');
  assert.equal(projectFrameAuthority(getDb(), engineer, 'chat.send', { projectId: '../x' }).reason, 'not_found');
  const legacy = projectFrameAuthority(getDb(), engineer, 'chat.send', {});
  assert.equal(legacy.ok, true);
  assert.equal(legacy.scoped, false);
});

test('a command that cannot carry a project id is not project-scoped', () => {
  const out = projectFrameAuthority(getDb(), engineer, 'host.ping', { projectId: 'p-host' });
  assert.equal(out.ok, true);
  assert.equal(out.scoped, false);
});

test('hub rule: a project-scoped frame without projectId is required; sessions/history are project-scoped reads', () => {
  const noProject = projectFrameAuthority(getDb(), engineer, 'chat.sessions', {}, { requireProject: true });
  assert.equal(noProject.ok, false);
  assert.equal(noProject.reason, 'required');
  // A command that cannot carry a project is not affected by the hub rule.
  assert.equal(projectFrameAuthority(getDb(), engineer, 'host.ping', {}, { requireProject: true }).ok, true);
  // The project-scoped read commands check the project grant like any other project frame.
  assert.equal(projectFrameAuthority(getDb(), engineer, 'chat.sessions', { projectId: 'p-host' }).ok, true);
  assert.equal(projectFrameAuthority(getDb(), outsider, 'chat.sessions', { projectId: 'p-host' }).ok, true);
  assert.equal(projectFrameAuthority(getDb(), outsider, 'chat.history', { projectId: 'p-host' }).ok, true);
});
