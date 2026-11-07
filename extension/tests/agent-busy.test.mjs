// Busy summary for the SDK updater: GET /kb/agent-sdk reports the running
// chat turns and Loop runs (counts only), and a Loop run is counted while it
// is in flight, whether it ends normally or throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(here, '_agent-busy-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { beginLoopRun, agentBusySummary } = await import('../core/agent-busy.mjs');
const { handleLoopAgentRoutes } = await import('../routes/loop-agent.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { grant } = await import('./helpers/grant.mjs');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busy-')));
const userId = users.registerUser(kb.getDb(), {
  email: `busy-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'busy',
}).id;
// R-014#1: the Loop route applies the member authority (owner + execute, no cap).
grant(kb.getDb(), userId, { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });

function makeReq(url, body, method = 'POST') {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, headers: {}, user: { id: userId }, socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
    destroy() {},
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}

const validateRoot = () => ({ ok: true, root: SANDBOX });
const loopBody = { message: 'hello', repoRoot: SANDBOX };

test('beginLoopRun counts a run up and down; ending twice is a no-op', () => {
  assert.equal(agentBusySummary(0).loopRuns, 0);
  const endA = beginLoopRun();
  const endB = beginLoopRun();
  assert.deepEqual(agentBusySummary(2), { chatTurns: 2, loopRuns: 2, total: 4 });
  endA();
  endA();
  assert.equal(agentBusySummary(0).loopRuns, 1, 'a double end must not count twice');
  endB();
  assert.deepEqual(agentBusySummary(0), { chatTurns: 0, loopRuns: 0, total: 0 });
});

test('a Loop run is counted while it runs and released after it answers', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let seen = null;
  const runAgent = async () => {
    seen = agentBusySummary(0).loopRuns;
    await gate;
    return { reply: 'ok', changedPaths: [], usage: {}, ran: true, resultSubtype: 'success', denied: [], toolEvents: [] };
  };
  const res = makeRes();
  const pending = handleLoopAgentRoutes(makeReq('/kb/loop/agent-run', loopBody), res, { userId }, { runAgent, validateRoot });
  // Let the handler reach runAgent before asking.
  for (let i = 0; i < 50 && seen === null; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(seen, 1, 'the run is counted while it is in flight');
  release();
  await pending;
  assert.equal(res.statusCode, 200, res._body);
  assert.equal(agentBusySummary(0).loopRuns, 0, 'the count falls after the run');
});

test('a Loop run that throws is released too', async () => {
  const runAgent = async () => { throw Object.assign(new Error('engine broke'), { code: 'ENGINE_ERROR' }); };
  const res = makeRes();
  await handleLoopAgentRoutes(makeReq('/kb/loop/agent-run', loopBody), res, { userId }, { runAgent, validateRoot });
  assert.equal(res.statusCode, 502);
  assert.equal(agentBusySummary(0).loopRuns, 0, 'a throw must not leave the count raised');
});

test('GET /kb/agent-sdk carries busy {chatTurns, loopRuns, total} as counts only', async () => {
  const end = beginLoopRun();
  try {
    const res = makeRes();
    await handleKB(makeReq('/kb/agent-sdk', undefined, 'GET'), res);
    // The GET is served from the same process: the body is the status object.
    const body = JSON.parse(res._body);
    assert.deepEqual(Object.keys(body.busy).sort(), ['chatTurns', 'loopRuns', 'total']);
    assert.equal(body.busy.loopRuns, 1);
    assert.equal(typeof body.busy.chatTurns, 'number');
    assert.equal(body.busy.total, body.busy.chatTurns + body.busy.loopRuns);
    assert.equal(JSON.stringify(body.busy).includes(userId), false, 'no user id in the busy summary');
  } finally {
    end();
    kb.closeDb();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
});
