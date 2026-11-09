// R-034 #1 / user decision D1: on a HUB only a team owner/admin may execute. Every other member is
// clamped to read_only in `authorizeAction` AND in the turn authority, because an execute turn runs
// agent Bash as the core's uid and the core's environment holds the JWT/vault secrets.
// A local/solo install is unchanged (tested in project-roles.test.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_HUB = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-hub-clamp-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');

const kb = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { registerProject, setProjectMember, effectiveProjectGrant } = await import('../kb/projects.mjs');
const { authorizeAction } = await import('../server/route-authority.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');

const db = kb.getDb();
let seq = 0;
function user(teamRole, maxMode) {
  const id = `hc-${++seq}`;
  db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')")
    .run(id, `${id}@example.com`, id);
  grant(db, id, { teamRole, maxMode, usdCapMonth: 0 });
  return id;
}

const owner = user('owner', 'execute');
const admin = user('admin', 'execute');
const engineer = user('member', 'execute');
const projectOwner = user('member', 'execute');

const PROJECT_ROOT = path.join(dir, 'project');
fs.mkdirSync(PROJECT_ROOT, { recursive: true });
registerProject(db, owner, { id: 'p-clamp', root: PROJECT_ROOT, name: 'Clamp' });
setProjectMember(db, owner, 'p-clamp', engineer, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
// A project owner who is only a TEAM member is still clamped: project.admin is not team admin (ADR 0022).
setProjectMember(db, owner, 'p-clamp', projectOwner, { role: 'owner', maxMode: 'execute', usdCapMonth: 0 });

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R-034 #1: a hub engineer with an execute row is refused execute-class actions', () => {
  const exec = authorizeAction(db, engineer, 'model.exec', { projectId: 'p-clamp' });
  assert.equal(exec.ok, false);
  assert.equal(exec.reason, 'max_mode_insufficient');
  for (const cls of ['fs.write', 'external.write', 'install']) {
    assert.equal(authorizeAction(db, engineer, cls, { projectId: 'p-clamp' }).ok, false, cls);
  }
  // Read/Ask classes still pass.
  assert.equal(authorizeAction(db, engineer, 'model.ask', { projectId: 'p-clamp' }).ok, true);
  assert.equal(authorizeAction(db, engineer, 'fs.read', { projectId: 'p-clamp' }).ok, true);
});

test('R-034 #1: team owner and team admin keep execute on a hub', () => {
  for (const uid of [owner, admin]) {
    assert.equal(authorizeAction(db, uid, 'model.exec', { projectId: 'p-clamp' }).ok, true, uid);
    assert.equal(authorizeAction(db, uid, 'fs.write', { projectId: 'p-clamp' }).ok, true, uid);
    assert.equal(effectiveProjectGrant(db, uid, 'p-clamp').maxMode, 'execute', uid);
  }
});

test('R-034 #1: a project owner/admin who is a team member is clamped too', () => {
  const g = effectiveProjectGrant(db, projectOwner, 'p-clamp');
  assert.equal(g.role, 'owner', 'the project role is still shown');
  assert.equal(g.maxMode, 'read_only', 'but the run mode is clamped on a hub');
  assert.equal(authorizeAction(db, projectOwner, 'model.exec', { projectId: 'p-clamp' }).ok, false);
});

function makeReq(body) {
  return {
    method: 'POST', url: '/agent/v2/stream', user: null, headers: {},
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
      else if (event === 'end' || event === 'close') cb();
      return this;
    },
  };
}
function makeRes() {
  return {
    on() { return this; }, statusCode: 200, _body: '',
    writeHead(code) { this.statusCode = code; }, write(c) { this._body += c; }, end(c) { if (c) this._body += c; },
    json() { return JSON.parse(this._body); },
    sseEvents() { return this._body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6))); },
  };
}

/** A fake turn that records the mode/authority the route handed the engine. */
function fakeTurn() {
  const calls = [];
  const runTurn = async (args) => {
    calls.push(args);
    args.onEvent?.({ type: 'init', sessionId: 'sdk-clamp', tools: [], capabilities: [] });
    args.onEvent?.({ type: 'result', subtype: 'success', costUsd: 0, sessionId: 'sdk-clamp', stopReason: 'end_turn' });
    return { usageTotals: {} };
  };
  return { calls, runTurn };
}

async function turn(userId, body, deps) {
  const res = makeRes();
  await handleAgentV2Routes({
    ...makeReq({ message: 'go', mode: 'execute', agentContext: { chatSessionId: `chat-${++seq}`, workspaceRoot: PROJECT_ROOT }, ...body }),
    user: { id: userId },
  }, res, deps);
  return res;
}

test('R-034 #1: the TURN clamp turns an engineer execute request into Ask on a hub', async () => {
  const fake = fakeTurn();
  const res = await turn(engineer, {}, { runTurn: fake.runTurn, classifyMode: async () => ({ mode: 'execute' }), expandSlash: () => null });
  assert.equal(res.statusCode, 200);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].mode, 'ask', 'execute was clamped to the tool-restricted Ask mode');
});

test('R-034 #1: the TURN clamp leaves owner and admin on execute', async () => {
  for (const uid of [owner, admin]) {
    const fake = fakeTurn();
    const res = await turn(uid, {}, { runTurn: fake.runTurn, classifyMode: async () => ({ mode: 'execute' }), expandSlash: () => null });
    assert.equal(res.statusCode, 200, uid);
    assert.equal(fake.calls[0].mode, 'execute', uid);
  }
});
