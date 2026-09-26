// The model picker's live Claude list (llm_agent/sdk/models.mjs): asked of the
// Agent SDK, so a `claude login` user with no API key gets the account's real
// models instead of a hardcoded list that went stale on every release.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_sdk-models-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
delete process.env.ANTHROPIC_API_KEY;

const { mapSupportedModels, listSdkModels, __clearSdkModelsCacheForTest } = await import('../llm_agent/sdk/models.mjs');

beforeEach(() => __clearSdkModelsCacheForTest());

// What supportedModels() returned for a real subscription login (2026-09-26).
const REAL = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

test('mapSupportedModels: canonical ids, generation-bearing names, the SDK default first, no "default" row', () => {
  const out = mapSupportedModels(REAL);
  assert.deepEqual(out.map((m) => [m.id, m.displayName]), [
    ['claude-opus-5[1m]', 'Opus 5 (1M)'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
  ]);
  // The default moves to the front even when the SDK lists it later.
  const reordered = mapSupportedModels([{ ...REAL[0], resolvedModel: 'claude-sonnet-5' }, ...REAL.slice(1)]);
  assert.equal(reordered[0].id, 'claude-sonnet-5');
  assert.deepEqual(mapSupportedModels(null), []);
  assert.deepEqual(mapSupportedModels([{ value: 'gpt-5' }, null]), [], 'only Claude ids');
});

function fakeQuery(rows, calls) {
  return (args) => {
    calls.push(args);
    return {
      supportedModels: async () => (typeof rows === 'function' ? rows() : rows),
      close: () => { calls.closed = (calls.closed || 0) + 1; },
    };
  };
}

test('listSdkModels: asks an idle session with no tools or settings, closes it, and caches', async () => {
  const calls = [];
  const queryFn = fakeQuery(REAL, calls);
  const first = await listSdkModels('u1', { queryFn });
  assert.equal(first[0].id, 'claude-opus-5[1m]');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.tools, []);
  assert.deepEqual(calls[0].options.settingSources, []);
  assert.equal(calls[0].options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(calls.closed, 1, 'the session is closed after answering');
  await listSdkModels('u1', { queryFn });
  assert.equal(calls.length, 1, 'served from cache');
  // Past the cache window it asks again.
  await listSdkModels('u1', { queryFn, now: () => Date.now() + 31 * 60 * 1000 });
  assert.equal(calls.length, 2);
});

test('listSdkModels: an SDK failure or an empty answer throws (the route falls back), and is not cached', async () => {
  const calls = [];
  await assert.rejects(listSdkModels('u2', { queryFn: fakeQuery(() => { throw new Error('Not logged in'); }, calls) }), /Not logged in/);
  assert.equal(calls.closed, 1, 'closed on failure too');
  // Remembered for a minute: no second CLI spawn, the same error at once.
  await assert.rejects(listSdkModels('u2', { queryFn: fakeQuery(REAL, calls) }), /Not logged in/);
  assert.equal(calls.length, 1);
  const later = () => Date.now() + 61 * 1000;
  await assert.rejects(listSdkModels('u2', { queryFn: fakeQuery([], calls), now: later }), /no Claude models/);
  const ok = await listSdkModels('u2', { queryFn: fakeQuery(REAL, calls), now: () => Date.now() + 2 * 61 * 1000 });
  assert.equal(ok.length, 4);
});

test('listSdkModels: concurrent requests share one SDK call', async () => {
  const calls = [];
  let answer;
  const queryFn = fakeQuery(() => new Promise((r) => { answer = r; }), calls);
  const a = listSdkModels('u3', { queryFn });
  const b = listSdkModels('u3', { queryFn });
  await new Promise((r) => setImmediate(r));
  answer(REAL);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1, 'one CLI for both');
  assert.deepEqual(ra, rb);
});
