import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_tool-events-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { recordUsage } = await import('../kb/usage.mjs');
const U = users.registerUser(db.getDb(), {
  email: `te-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 't',
}).id;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('recordToolEvents writes one row per event and never stores text', () => {
  const n = db.recordToolEvents(U, {
    turnId: 't1', engine: 'v2', mode: 'execute',
    events: [{ tool: 'find-code', resultChars: 900 }, { tool: 'Read', resultChars: 4000, truncated: false }],
  });
  assert.equal(n, 2);
  const cols = db.getDb().prepare('PRAGMA table_info(turn_tool_events)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /arg|text|content|body/.test(c)), 'no column may hold tool text');
});

test('recordToolEvents is best-effort: bad input returns 0, never throws', () => {
  assert.equal(db.recordToolEvents(U, { turnId: '', engine: 'v2', events: [{ tool: 'x', resultChars: 1 }] }), 0);
  assert.equal(db.recordToolEvents(U, { turnId: 't9', engine: 'v2', events: 'nope' }), 0);
});

test('summarizeToolEvents: find-code share, order, and token split via the ledger', () => {
  // t1 (above): find-code THEN Read. t2: Read only.
  db.recordToolEvents(U, { turnId: 't2', engine: 'v2', events: [{ tool: 'Read', resultChars: 20000, truncated: true }] });
  recordUsage(db.getDb(), { userId: U, provider: 'anthropic', model: 'm', endpoint: '/agent/v2/stream',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 1000, requestId: 't1' });
  recordUsage(db.getDb(), { userId: U, provider: 'anthropic', model: 'm', endpoint: '/agent/v2/stream',
    inputTokens: 20, outputTokens: 7, cacheReadTokens: 200, cacheCreationTokens: 9000, requestId: 't2' });

  const s = db.summarizeToolEvents(U, { days: 7 });
  assert.equal(s.turns, 2);
  assert.equal(s.turnsWithFindCode, 1);
  assert.equal(s.findCodeFirstTurns, 1);
  const read = s.byTool.find((r) => r.tool === 'Read');
  assert.equal(read.calls, 2);
  assert.equal(read.avgChars, 12000);
  assert.equal(s.tokensWithFindCode.cacheCreation, 1000);
  assert.equal(s.tokensWithoutFindCode.cacheCreation, 9000);
});

test('legacy memory push becomes one memory_push event, none when empty', async () => {
  const { memoryPushEvent } = await import('../llm_agent/runtime/memory-push-event.mjs');
  assert.deepEqual(memoryPushEvent(0), []);
  assert.deepEqual(memoryPushEvent(1234), [{ tool: 'memory_push', resultChars: 1234 }]);
});

test('summarizeToolEventsOn works with a readonly DB handle (proves query is write-free)', () => {
  // Open the same test DB a second time with readonly handle
  const roDb = new Database(tmpDb, { readonly: true });
  try {
    const result = db.summarizeToolEventsOn(roDb, U, { days: 7 });
    const expected = db.summarizeToolEvents(U, { days: 7 });
    assert.equal(result.turns, expected.turns);
    assert.equal(result.turnsWithFindCode, expected.turnsWithFindCode);
    assert.equal(result.findCodeFirstTurns, expected.findCodeFirstTurns);
  } finally {
    roDb.close();
  }
});

test('the summary module can be imported without rotating server.log (report is read-only)', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-log-'));
  const logFile = path.join(dir, 'server.log');
  fs.writeFileSync(logFile, 'sentinel\n');
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      "await import('./kb/tool-events-summary.mjs')"], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, LLMIDE_LOG_FILE: logFile }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(logFile), 'server.log must not be rotated away');
    assert.ok(!fs.existsSync(`${logFile}.old`));
    assert.equal(fs.readFileSync(logFile, 'utf8'), 'sentinel\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
