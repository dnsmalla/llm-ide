// R-023 #1: on a hub every route that acts on a folder refuses a missing folder (400 PROJECT_REQUIRED) and a
// folder inside no project (403 PROJECT_DENIED) — Loop, codegen and install-skills, not only chat turns.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_HUB = '1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-hub-folders-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');

const kb = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const { hubFolderRefusal } = await import('../server/route-authority.mjs');
const { handleLoopAgentRoutes } = await import('../routes/loop-agent.mjs');
const { handlePlanningRoutes } = await import('../routes/planning.mjs');
const { handleKB } = await import('../routes/router.mjs');

kb.getDb().prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u1','h@x.y','H','x','user','active')").run();
grant(kb.getDb(), 'u1', { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(handler, { method = 'POST', url, body, ctx = {} }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: 'u1' }, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    on(e, cb) { if (e === 'data') chunks.forEach((c) => cb(c)); else if (e === 'end') cb(); return req; },
  };
  const res = {
    statusCode: 200, _body: '',
    writeHead(c) { this.statusCode = c; }, setHeader() {}, write(c) { this._body += c; }, end(c) { if (c) this._body += c; },
    json() { return JSON.parse(this._body); },
  };
  return handler(req, res, ctx).then((handled) => ({ handled, status: res.statusCode, body: res.json ? (() => { try { return res.json(); } catch { return null; } })() : null }));
}

const outside = path.join(dir, 'not-a-project');

test('hubFolderRefusal: missing, outside, inside', () => {
  assert.deepEqual(hubFolderRefusal(undefined, null), { status: 400, code: 'PROJECT_REQUIRED', message: 'A project folder is required on this hub' });
  assert.equal(hubFolderRefusal(outside, null).code, 'PROJECT_DENIED');
  assert.equal(hubFolderRefusal(outside, 'p-x'), null);
});

test('Loop: a hub run without a repoRoot, or in an unregistered folder, is refused before the engine', async () => {
  const projectRoot = fs.mkdtempSync(path.join(dir, 'proj-'));
  registerProject(kb.getDb(), 'u1', { id: 'p-loop', root: projectRoot });
  const missing = await call(handleLoopAgentRoutes, { url: '/kb/loop/agent-run', body: { message: 'go' }, ctx: { userId: 'u1' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'PROJECT_REQUIRED');
  const unregistered = await call(handleLoopAgentRoutes, { url: '/kb/loop/agent-run', body: { message: 'go', repoRoot: outside, projectId: 'p-loop' }, ctx: { userId: 'u1' } });
  assert.equal(unregistered.status, 403);
  assert.equal(unregistered.body.error.code, 'PROJECT_DENIED');
});

test('generate-code: same folder rule', async () => {
  const missing = await call(handlePlanningRoutes, { url: '/kb/generate-code', body: { taskId: 't1' }, ctx: { userId: 'u1', url: '/kb/generate-code' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'PROJECT_REQUIRED');
  const unregistered = await call(handlePlanningRoutes, { url: '/kb/generate-code', body: { taskId: 't1', repo: outside }, ctx: { userId: 'u1', url: '/kb/generate-code' } });
  assert.equal(unregistered.status, 403);
  assert.equal(unregistered.body.error.code, 'PROJECT_DENIED');
});

test('install-skills: same folder rule through the main dispatcher', async () => {
  const missing = await call(handleKB, { url: '/kb/project/install-skills', body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'PROJECT_REQUIRED');
  const unregistered = await call(handleKB, { url: '/kb/project/install-skills', body: { path: outside } });
  assert.equal(unregistered.status, 403);
  assert.equal(unregistered.body.error.code, 'PROJECT_DENIED');
});
