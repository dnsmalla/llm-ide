// The project turn clamp (ADR 0022): a turn in a registered project folder uses the project grant —
// the implicit viewer, the project role/mode, the project USD cap — and its ledger row carries the
// project id. Hermetic: scratch DB, req/res doubles, fake turn runner.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-agent-project-clamp-'));
process.env.LLMIDE_DB_PATH = path.join(root, 'kb.db');
const projectRoot = path.join(root, 'project');
fs.mkdirSync(path.join(projectRoot, 'system'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'system', 'project.json'), '{}');

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const { registerProject, setProjectMember } = await import('../kb/projects.mjs');
const { grant } = await import('./helpers/grant.mjs');

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
function member(teamRole = 'member', maxMode = 'execute', usdCapMonth = 0) {
  const user = registerUser(getDb(), {
    email: `pclamp-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  grant(getDb(), user.id, { teamRole, maxMode, usdCapMonth });
  return user;
}
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers: {}, socket: { remoteAddress: '10.9.9.8' },
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
    statusCode: 200, headers: {}, _body: '', ended: false, headersSent: false,
    on() { return this; },
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += String(chunk); return true; },
    end(chunk) { if (chunk) this._body += String(chunk); this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
function fakeTurn(usageTotals = {}) {
  const calls = [];
  const runTurn = async (args) => {
    calls.push(args);
    args.onEvent({ type: 'init', sessionId: 'sdk-p', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    args.onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-p', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals };
  };
  return { calls, runTurn };
}
function stream(user, body, deps, workspaceRoot = projectRoot) {
  const res = makeRes();
  return handleAgentV2Routes(makeReq({
    method: 'POST', url: '/agent/v2/stream', user,
    body: { agentContext: { chatSessionId: `pchat-${++seq}`, workspaceRoot }, ...body },
  }), res, deps).then(() => res);
}

const owner = member('member', 'execute', 0);
registerProject(getDb(), owner.id, { id: 'p-clamp', name: 'Clamp', root: projectRoot });

test('a member with no project row is an implicit viewer: an execute request is clamped to Ask', async () => {
  const outsider = member('member', 'execute', 0);
  const turn = fakeTurn();
  const res = await stream(outsider, { message: 'go', mode: 'execute' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'ask');
});

test('a project member runs execute; a read_only project grant is clamped; a global admin overrides', async () => {
  const engineer = member('member', 'execute', 0);
  setProjectMember(getDb(), owner.id, 'p-clamp', engineer.id, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
  const t1 = fakeTurn();
  const res1 = await stream(engineer, { message: 'go', mode: 'execute' }, { runTurn: t1.runTurn });
  assert.equal(res1.statusCode, 200);
  assert.equal(t1.calls[0].mode, 'execute');

  setProjectMember(getDb(), owner.id, 'p-clamp', engineer.id, { role: 'member', maxMode: 'read_only', usdCapMonth: 0 });
  const t2 = fakeTurn();
  const res2 = await stream(engineer, { message: 'go', mode: 'execute' }, { runTurn: t2.runTurn });
  assert.equal(res2.statusCode, 200);
  assert.equal(t2.calls[0].mode, 'ask');

  const admin = member('admin', 'execute', 0);
  const t3 = fakeTurn();
  const res3 = await stream(admin, { message: 'go', mode: 'execute' }, { runTurn: t3.runTurn });
  assert.equal(res3.statusCode, 200);
  assert.equal(t3.calls[0].mode, 'execute', 'a global admin overrides a project with no row');
});

test('a project cap sums the project month only and refuses before the engine starts', async () => {
  const engineer = member('member', 'execute', 0);
  setProjectMember(getDb(), owner.id, 'p-clamp', engineer.id, { role: 'member', maxMode: 'execute', usdCapMonth: 5 });
  // Spend in another project never counts; spend in this one does.
  getDb().prepare("INSERT INTO usage_ledger (user_id, provider, model, source, runs, cost_usd, project_id) VALUES (?, 'anthropic', 'm', 'api', 1, 100, 'p-other')").run(engineer.id);
  const okTurn = fakeTurn();
  const ok = await stream(engineer, { message: 'go', mode: 'execute' }, { runTurn: okTurn.runTurn });
  assert.equal(ok.statusCode, 200, ok._body);
  assert.equal(okTurn.calls.length, 1);

  getDb().prepare("INSERT INTO usage_ledger (user_id, provider, model, source, runs, cost_usd, project_id) VALUES (?, 'anthropic', 'm', 'api', 1, 5, 'p-clamp')").run(engineer.id);
  const refused = fakeTurn();
  const res = await stream(engineer, { message: 'go', mode: 'execute' }, { runTurn: refused.runTurn });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error.code, 'USD_CAP');
  assert.equal(refused.calls.length, 0);
});

test('a successful project turn writes project_id on its ledger rows', async () => {
  const engineer = member('member', 'execute', 0);
  setProjectMember(getDb(), owner.id, 'p-clamp', engineer.id, { role: 'member', maxMode: 'execute', usdCapMonth: 0 });
  const turn = fakeTurn({ inputTokens: 100, outputTokens: 20, costUsd: 0.01, calls: 1 });
  const res = await stream(engineer, { message: 'go', mode: 'execute', model: 'claude-sonnet-5' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  const row = getDb().prepare(
    'SELECT project_id, cost_usd FROM usage_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1',
  ).get(engineer.id);
  assert.equal(row.project_id, 'p-clamp');
});

test('an explicit projectId (Host API style) is honoured without the workspace root', async () => {
  const engineer = member('member', 'execute', 0);
  setProjectMember(getDb(), owner.id, 'p-clamp', engineer.id, { role: 'member', maxMode: 'read_only', usdCapMonth: 0 });
  const turn = fakeTurn();
  const res = await stream(engineer, { message: 'go', mode: 'execute', projectId: 'p-clamp' }, { runTurn: turn.runTurn }, '/not/a/project');
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'ask');
});
