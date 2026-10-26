// GET /kb/os/stream: the System view's change channel. Tenancy, the emitters
// that feed it, per-stream coalescing, the per-user cap, and cleanup. The
// handler is driven in-process with a fake request/response (no socket), so it
// runs in sandboxes that refuse local listen. Its own temp DB; no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_os-stream-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
}

const { getDb } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { handleOsRoutes, configureOsRoutes } = await import('../routes/os.mjs');
const { recordActivity } = await import('../kb/activity.mjs');
const { recordUsage } = await import('../kb/usage.mjs');
const { emitOsEvent, onOsEvent, osEventListenerCount } = await import('../core/os-events.mjs');
const { appendCaptions } = await import('../agents/live-sessions.mjs');

configureOsRoutes({ apiVersion: 79, health: async () => ({ status: 'ok', checks: { db: true } }) });

const db = getDb();
const userA = registerUser(db, { email: 'os-stream-a@example.com', password: 'pw-12345678' }).id;
const userB = registerUser(db, { email: 'os-stream-b@example.com', password: 'pw-12345678' }).id;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A minimal ServerResponse stand-in: records every write. */
function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200, headers: {}, chunks: [], writable: true, writableFinished: false, destroyed: false, headersSent: false,
    writeHead(status, headers = {}) { res.statusCode = status; Object.assign(res.headers, headers); res.headersSent = true; return res; },
    setHeader(k, v) { res.headers[k] = v; },
    write(chunk) { res.chunks.push(String(chunk)); return true; },
    end(chunk) {
      if (chunk) res.chunks.push(String(chunk));
      res.writable = false; res.writableFinished = true; res.headersSent = true;
      res.emit('finish');
    },
  });
  return res;
}

function fakeReq(url) {
  const req = new EventEmitter();
  Object.assign(req, { method: 'GET', url, socket: Object.assign(new EventEmitter(), { destroyed: false }) });
  return req;
}

/** Open the stream as `userId`; returns { res, events(), disconnect() }. */
async function openStream(userId) {
  const res = fakeRes();
  const handled = await handleOsRoutes(fakeReq('/kb/os/stream'), res, { userId, url: '/kb/os/stream' });
  assert.equal(handled, true);
  return {
    res,
    events() {
      const text = res.chunks.join('');
      const out = [];
      for (const block of text.split('\n\n')) {
        let event = null; let data = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6));
        }
        if (event) out.push({ event, data });
      }
      return out;
    },
    types() { return this.events().map((e) => e.data.type).filter((t) => t !== 'hello'); },
    disconnect() {
      // A client that went away: the socket closes before the response finished.
      res.writable = false;
      res.emit('close');
    },
  };
}

test('the stream opens with a hello event and carries only type and at', async () => {
  const s = await openStream(userA);
  assert.equal(s.res.statusCode, 200);
  assert.equal(s.res.headers['Content-Type'], 'text/event-stream');
  const [hello] = s.events();
  assert.equal(hello.event, 'hello');
  assert.deepEqual(Object.keys(hello.data).sort(), ['at', 'type']);
  s.disconnect();
});

test('tenancy: user B never sees user A events', async () => {
  const a = await openStream(userA);
  const b = await openStream(userB);
  recordActivity(db, { userId: userA, kind: 'knowledge_updated', title: 'A only' });
  assert.deepEqual(a.types(), ['activity']);
  assert.deepEqual(b.types(), []);
  a.disconnect();
  b.disconnect();
});

test('recordActivity emits activity', async () => {
  const s = await openStream(userA);
  recordActivity(db, { userId: userA, kind: 'meeting_added', title: 'emit check' });
  assert.ok(s.types().includes('activity'));
  s.disconnect();
});

test('recordUsage emits usage', async () => {
  const s = await openStream(userA);
  const id = recordUsage(db, { userId: userA, provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5 });
  assert.ok(id);
  assert.ok(s.types().includes('usage'));
  s.disconnect();
});

test('appendCaptions creating a live session emits live-session', async () => {
  const s = await openStream(userA);
  appendCaptions(userA, 'os-stream-session-1', [{ speaker: 'x', text: 'hi', ts: Date.now() }], 'Standup');
  assert.ok(s.types().includes('live-session'));
  s.disconnect();
});

test('bursts of one type are coalesced to at most one event per 250 ms per stream', async () => {
  const s = await openStream(userA);
  for (let i = 0; i < 10; i++) {
    recordUsage(db, { userId: userA, provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1 });
  }
  // The first event of the burst goes out at once; the other nine collapse into one trailing event.
  assert.equal(s.types().filter((t) => t === 'usage').length, 1);
  await sleep(400);
  assert.equal(s.types().filter((t) => t === 'usage').length, 2);
  // Nothing more: the window closes once it has no pending event.
  await sleep(400);
  assert.equal(s.types().filter((t) => t === 'usage').length, 2);
  s.disconnect();
});

test('per-user cap: a fifth concurrent stream is refused with 429, and a freed slot is reusable', async () => {
  const user = 'user-cap-probe';
  const open = [];
  for (let i = 0; i < 4; i++) open.push(await openStream(user));
  const fifth = await openStream(user);
  assert.equal(fifth.res.statusCode, 429);
  assert.equal(JSON.parse(fifth.res.chunks.join('')).error.code, 'TOO_MANY_STREAMS');
  open[0].disconnect();
  const again = await openStream(user);
  assert.equal(again.res.statusCode, 200);
  again.disconnect();
  open.slice(1).forEach((h) => h.disconnect());
  assert.equal(osEventListenerCount(user), 0);
});

test('cleanup on disconnect removes every listener', async () => {
  const s = await openStream(userA);
  assert.ok(osEventListenerCount(userA) >= 1);
  s.disconnect();
  assert.equal(osEventListenerCount(userA), 0);
});

test('emitting with no subscribers is a no-op, and bad input never throws', () => {
  assert.equal(osEventListenerCount('nobody'), 0);
  assert.doesNotThrow(() => emitOsEvent('nobody', 'usage'));
  assert.doesNotThrow(() => emitOsEvent(undefined, 'usage'));
  assert.doesNotThrow(() => emitOsEvent(userA, 'not-a-type'));
});

test('onOsEvent unsubscribe is idempotent and stops delivery', () => {
  const seen = [];
  const off = onOsEvent('bus-user', (ev) => seen.push(ev.type));
  emitOsEvent('bus-user', 'activity');
  off();
  off();
  emitOsEvent('bus-user', 'activity');
  assert.deepEqual(seen, ['activity']);
  assert.equal(osEventListenerCount('bus-user'), 0);
});
