// GET /kb/os/state "running now" section: this user's chat turns, meeting-agent
// runs and live sessions, each with its cancel route. Its own temp DB; the
// chat turn uses an injected parked runTurn, so no model call is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_os-state-running-test.db');
const wsRoot = path.join(__dirname, '_os-state-running-ws');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
}
fs.mkdirSync(wsRoot, { recursive: true });

const { getDb } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const { handleOsRoutes, configureOsRoutes } = await import('../routes/os.mjs');
const liveSessions = await import('../agents/live-sessions.mjs');
const meetingAgent = await import('../agents/meeting-agent.mjs');

configureOsRoutes({ apiVersion: 79, health: async () => ({ status: 'ok', checks: { db: true } }) });

const db = getDb();
const userA = registerUser(db, { email: 'os-run-a@example.com', password: 'pw-12345678' }).id;
const userB = registerUser(db, { email: 'os-run-b@example.com', password: 'pw-12345678' }).id;

function fakeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    user,
    headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end' || event === 'close') cb();
      return this;
    },
  };
}

function fakeRes() {
  return {
    on() { return this; },
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this.body += chunk; },
    end(chunk) { if (chunk) this.body += chunk; this.headersSent = true; },
    json() { return JSON.parse(this.body); },
  };
}

async function getState(userId) {
  const res = fakeRes();
  await handleOsRoutes(fakeReq({ method: 'GET', url: '/kb/os/state', user: { id: userId } }), res, { userId, url: '/kb/os/state' });
  return res.json();
}

test('running — lists only this user’s chat turns, meeting runs and live sessions, each with its cancel route', async () => {
  // A chat turn for user A that parks until aborted.
  let turnStarted;
  const started = new Promise((resolve) => { turnStarted = resolve; });
  const turnRes = fakeRes();
  const turnDone = handleAgentV2Routes(fakeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    user: { id: userA },
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-os-1', workspaceRoot: wsRoot } },
  }), turnRes, {
    runTurn: async ({ onEvent, signal }) => {
      onEvent({ type: 'init', sessionId: 'sdk-os-1', claudeCodeVersion: '0', tools: [], capabilities: [] });
      turnStarted();
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
      });
      return { result: null, usageTotals: {} };
    },
  });
  await started;

  liveSessions.appendCaptions(userA, 'live-os-1', [{ speaker: 'Example', text: 'hello', ts: Date.now(), source: 'extension-cc' }]);
  await meetingAgent.dispatchAgent({ userId: userA, sessionId: 'live-os-1' });
  liveSessions.appendCaptions(userB, 'live-os-b', [{ speaker: 'Example', text: 'hi', ts: Date.now(), source: 'extension-cc' }]);

  const a = (await getState(userA)).running;
  assert.equal(a.chatTurns.length, 1);
  assert.equal(a.chatTurns[0].chatSessionId, 'chat-os-1');
  assert.equal(typeof a.chatTurns[0].startedAt, 'string');
  assert.deepEqual(a.chatTurns[0].cancel, { method: 'POST', path: '/agent/v2/cancel', body: { chatSessionId: 'chat-os-1' } });
  assert.equal(a.meetingAgentRuns.length, 1);
  assert.equal(a.meetingAgentRuns[0].sessionId, 'live-os-1');
  assert.deepEqual(a.meetingAgentRuns[0].cancel, { method: 'POST', path: '/kb/agent/stop', body: { sessionId: 'live-os-1' } });
  assert.deepEqual(a.liveSessions.map((s) => s.sessionId), ['live-os-1']);
  assert.equal(a.liveSessions[0].cancel, null);

  const b = (await getState(userB)).running;
  assert.deepEqual(b.chatTurns, []);
  assert.deepEqual(b.meetingAgentRuns, []);
  assert.deepEqual(b.liveSessions.map((s) => s.sessionId), ['live-os-b']);

  // Clean up: stop the run, cancel the turn, and the chat list empties.
  await meetingAgent.stopAgent({ userId: userA, sessionId: 'live-os-1' });
  await handleAgentV2Routes(fakeReq({
    method: 'POST', url: '/agent/v2/cancel', user: { id: userA }, body: { chatSessionId: 'chat-os-1' },
  }), fakeRes());
  await turnDone;
  assert.deepEqual((await getState(userA)).running.chatTurns, []);
});
