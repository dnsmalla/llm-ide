// R-020 Q1 decision: on a hub every project-scoped turn names a KNOWN project. No projectId (body or
// agentContext) → 400 PROJECT_REQUIRED; an unknown one → 403 PROJECT_DENIED; a valid one runs. There is no
// team-role fallback on a hub (a solo/local install keeps it for compatibility).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_HUB = '1'; // read once, at config load

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-project-hub-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');

const db = getDb();
db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('hub-u1', 'hub1@example.com', 'H', 'x', 'user', 'active')").run();
grant(db, 'hub-u1', { teamRole: 'member', maxMode: 'execute', usdCapMonth: 0 });
registerProject(db, 'hub-u1', { id: 'p-hub', root: '/r/hub', name: 'Hub project' });
const user = { id: 'hub-u1' };

function makeReq(body) {
  return {
    method: 'POST', url: '/agent/v2/stream', user, headers: {},
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

let turns = 0;
const fakeTurn = async ({ onEvent }) => {
  turns += 1;
  onEvent({ type: 'init', sessionId: 'sdk-hub', tools: [], capabilities: [] });
  onEvent({ type: 'result', subtype: 'success', costUsd: 0.01, sessionId: 'sdk-hub', stopReason: 'end_turn' });
  return { usageTotals: { inputTokens: 1, outputTokens: 1 } };
};
const run = async (body) => {
  const res = makeRes();
  await handleAgentV2Routes(makeReq({ message: 'go', mode: 'execute', agentContext: { chatSessionId: 'chat-hub', workspaceRoot: WS }, ...body }), res, { runTurn: fakeTurn });
  return res;
};

test('a hub turn in an unregistered folder without a projectId is refused PROJECT_DENIED', async () => {
  const res = await run({});
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'PROJECT_DENIED');
  assert.equal(turns, 0);
});

test('a hub turn with an unknown projectId is refused PROJECT_DENIED', async () => {
  const res = await run({ projectId: 'p-does-not-exist' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'PROJECT_DENIED');
  assert.equal(turns, 0);
});

test('a hub turn with a known projectId runs', async () => {
  const res = await run({ projectId: 'p-hub' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.sseEvents().some((e) => e.type === 'result'));
  assert.equal(turns, 1);
});

test('R-021 #1: a projectId that does not own the turn folder is PROJECT_MISMATCH', async () => {
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-other-'));
  registerProject(db, 'hub-u1', { id: 'p-other', root: otherRoot, name: 'Other' });
  const before = turns;
  const res = await run({ projectId: 'p-hub', agentContext: { chatSessionId: 'chat-mismatch', workspaceRoot: otherRoot } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'PROJECT_MISMATCH');
  assert.equal(turns, before, 'the mismatch never reached the engine');
});
