// The task route's agent path (POST /kb/tasks/review.*/run): the client's disconnect cancels the run, a capped
// member is refused like a bus job, a repo folder outside the project is refused, and a run writes its ledger row.
// Hermetic: a scratch DB and the route's `ctx.taskPorts` seam (the engine, git and project resolver are fakes).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
process.env.NODE_ENV = 'test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(here, '_task-route-review-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { recordUsage } = await import('../kb/usage.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');
const { handleTaskRoutes } = await import('../routes/tasks.mjs');

const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-route-review-')));

after(() => {
  try { closeDb(); } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

let seq = 0;
function user(teamRole, maxMode, usdCapMonth = 0) {
  const u = registerUser(getDb(), { email: `task-route-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't' });
  grant(getDb(), u.id, { teamRole, maxMode, usdCapMonth });
  return u;
}

// A request whose body is read through the async iterator the route uses, with the desktop's host proof.
// The body arrives after the route has attached its 'data' and 'end' listeners (readBody), as a socket delivers it.
function makeReq(url, body) {
  const req = new EventEmitter();
  Object.assign(req, {
    method: 'POST', url, headers: { 'x-llmide-host-nonce': busHostProof() }, socket: { remoteAddress: '127.0.0.1' }, pause() {},
  });
  setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}

// A response that can emit 'close' like a socket going away; `writableFinished` is set by end(), as Node does.
function makeRes() {
  const listeners = new Map();
  const out = { status: null, body: null };
  return {
    out,
    writableFinished: false,
    destroyed: false,
    writeHead(status) { out.status = status; },
    end(text) { out.body = JSON.parse(String(text)); this.writableFinished = true; },
    on(event, fn) { listeners.set(event, fn); },
    close() { listeners.get('close')?.(); },
  };
}

// The seam: a project that resolves to the scratch root, an engine that the test controls, and a git that says "repo".
function portsWith(runTask) {
  return {
    resolveProjectRoot: () => ({ root: projectRoot }),
    projectAllowed: () => true,
    runTask,
    engineIdFor: () => 'claude',
    runGit: async (_spawn, _cwd, args) => (args.includes('rev-parse') ? { code: 0, stdout: 'true\n' } : { code: 0, stdout: '' }),
    spawn: null,
  };
}

const RUN = '/kb/tasks/review.code/run';

test('closing the request before the answer aborts the review run', async () => {
  const u = user('owner', 'execute');
  let seen = null;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const ports = portsWith((opts) => new Promise((resolve) => {
    seen = opts.signal;
    started();
    opts.signal.addEventListener('abort', () => resolve({ text: '', stopReason: 'aborted', engine: 'claude' }));
  }));
  const res = makeRes();
  const call = handleTaskRoutes(makeReq(RUN, { projectId: 'p-cancel', args: {} }), res, { userId: u.id, url: RUN, taskPorts: ports });
  await running;
  assert.equal(seen.aborted, false, 'the run is live until the client goes away');
  res.close();
  assert.equal(await call, true);
  assert.equal(seen.aborted, true, 'the client going away aborted the run');
});

test('a run that finished normally is not aborted by the close that follows the answer', async () => {
  const u = user('owner', 'execute');
  let seen = null;
  const ports = portsWith(async (opts) => { seen = opts.signal; return { text: 'No findings.', stopReason: 'end', engine: 'claude' }; });
  const res = makeRes();
  await handleTaskRoutes(makeReq(RUN, { projectId: 'p-done', args: {} }), res, { userId: u.id, url: RUN, taskPorts: ports });
  res.close();
  assert.equal(res.out.status, 200);
  assert.equal(seen.aborted, false);
});

test('a member at the monthly USD cap is refused before the engine runs, as a bus job is', async () => {
  const u = user('member', 'execute', 1);
  recordUsage(getDb(), { userId: u.id, provider: 'anthropic', model: 'claude-x', costUsd: 5 });
  let engineCalls = 0;
  const res = makeRes();
  await handleTaskRoutes(makeReq(RUN, { projectId: 'p-cap', args: {} }), res, {
    userId: u.id, url: RUN, taskPorts: portsWith(async () => { engineCalls += 1; return { text: '' }; }),
  });
  assert.equal(res.out.status, 429);
  assert.equal(res.out.body.error.code, 'USD_CAP');
  assert.equal(engineCalls, 0);
});

test('a repo folder outside the project is refused and the engine never runs', async () => {
  const u = user('owner', 'execute');
  let engineCalls = 0;
  const res = makeRes();
  await handleTaskRoutes(makeReq(RUN, { projectId: 'p-repo', args: { repo: '../outside' } }), res, {
    userId: u.id, url: RUN, taskPorts: portsWith(async () => { engineCalls += 1; return { text: '' }; }),
  });
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.ok, false);
  assert.equal(res.out.body.code, 'REPO_NOT_ALLOWED');
  assert.equal(engineCalls, 0);
});

test('a repo folder inside the project is the one reviewed', async () => {
  const u = user('owner', 'execute');
  fs.mkdirSync(path.join(projectRoot, 'code', 'app'), { recursive: true });
  let cwdSeen = null;
  const res = makeRes();
  await handleTaskRoutes(makeReq(RUN, { projectId: 'p-inside', args: { repo: 'code/app' } }), res, {
    userId: u.id, url: RUN, taskPorts: portsWith(async (opts) => { cwdSeen = opts.cwd; return { text: 'No findings.', stopReason: 'end', engine: 'claude' }; }),
  });
  assert.equal(res.out.body.ok, true);
  assert.equal(cwdSeen, fs.realpathSync(path.join(projectRoot, 'code', 'app')));
});

test('a review run is metered in the usage ledger under its task id, with the model it was asked for', async () => {
  const u = user('owner', 'execute');
  let asked = null;
  const ports = portsWith(async (opts) => {
    asked = opts;
    return {
      text: 'No findings.', stopReason: 'end', engine: 'claude', model: 'claude-x',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5, numTurns: 3 },
      byModel: [{ model: 'claude-x', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    };
  });
  const res = makeRes();
  await handleTaskRoutes(makeReq(RUN, { projectId: 'p-meter', args: { model: 'claude-x' } }), res, { userId: u.id, url: RUN, taskPorts: ports });
  assert.equal(res.out.body.ok, true);
  assert.deepEqual(asked.engine, { provider: 'anthropic', model: 'claude-x' });
  const rows = getDb().prepare("SELECT source, endpoint, provider, model, cost_usd, turns, input_tokens FROM usage_ledger WHERE user_id = ? AND endpoint = 'auto-task:review.code'").all(u.id);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    source: 'auto-task', endpoint: 'auto-task:review.code', provider: 'anthropic', model: 'claude-x', cost_usd: 0.5, turns: 3, input_tokens: 100,
  });
});
