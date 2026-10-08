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

// SDK 0.3.283 changed the row shape: `displayName` now carries the generation
// ("Opus 5.5") and `description` is ONLY the tagline ("For complex work…") —
// no "Name · tagline" any more. Taking the description's lead then made every
// picker label a sentence ("Efficient for routine tasks" for Sonnet 5).
test('mapSupportedModels: the 0.3.283 row shape — name from displayName, tagline as description', () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks' },
  ];
  assert.deepEqual(mapSupportedModels(rows).map((m) => [m.id, m.displayName, m.description]), [
    ['claude-opus-5-5', 'Opus 5.5', 'For complex work and everyday tasks'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5', 'Fastest for quick answers'],
    ['claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks'],
  ]);
});

test('mapSupportedModels: a bare family displayName with a tagline-only description falls back to a name from the id', () => {
  const out = mapSupportedModels([{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Efficient for routine tasks' }]);
  assert.equal(out[0].displayName, 'Sonnet 5.5');
});

test('mapSupportedModels: effortLevels are the SDK\'s own list, unknown levels included', () => {
  const out = mapSupportedModels([
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'x',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'ultra'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'y', supportsEffort: false,
      supportedEffortLevels: ['low'] },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'z' },
    { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'w',
      supportedEffortLevels: ['high', '', 7, 'max'] },
  ]);
  assert.deepEqual(out.map((m) => [m.id, m.effortLevels]), [
    ['claude-sonnet-5', ['low', 'medium', 'high', 'ultra']],
    ['claude-haiku-4-5', []],
    ['claude-opus-5', []],
    ['claude-fable-5-1', ['high', 'max']],
  ]);
});

test('cachedEffortLevels: null before any listing; the model\'s levels after; the first model for a null id', async () => {
  const { cachedEffortLevels } = await import('../llm_agent/sdk/models.mjs');
  assert.equal(cachedEffortLevels('u-eff', 'claude-sonnet-5'), null, 'nothing cached yet');
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'x', supportedEffortLevels: ['low', 'high'] },
    { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'z', supportedEffortLevels: ['high', 'max'] },
  ];
  const queryFn = () => ({ supportedModels: async () => rows, close() {} });
  await listSdkModels('u-eff', { queryFn });
  assert.deepEqual(cachedEffortLevels('u-eff', 'claude-sonnet-5'), ['low', 'high']);
  assert.deepEqual(cachedEffortLevels('u-eff', null), ['high', 'max'], 'null = the SDK default, listed first');
  assert.deepEqual(cachedEffortLevels('u-eff', 'claude-unknown-9'), []);
});

test('cachedEffortLevels: falls back to a base-id match like the Mac (1M suffix, date snapshot); exact wins', async () => {
  const { cachedEffortLevels } = await import('../llm_agent/sdk/models.mjs');
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['high', 'max'] },
    { value: 'opus', resolvedModel: 'claude-opus-5', supportedEffortLevels: ['low'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportedEffortLevels: ['low', 'medium'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5[1m]', supportedEffortLevels: ['medium'] },
  ];
  await listSdkModels('u-base', { queryFn: () => ({ supportedModels: async () => rows, close() {} }) });
  assert.deepEqual(cachedEffortLevels('u-base', 'claude-sonnet-5'), ['medium'], 'plain id requested, [1m] listed');
  assert.deepEqual(cachedEffortLevels('u-base', 'claude-haiku-4-5'), ['low', 'medium'], 'undated requested, snapshot listed');
  assert.deepEqual(cachedEffortLevels('u-base', 'claude-opus-5'), ['low'], 'exact match beats a base match');
  assert.deepEqual(cachedEffortLevels('u-base', 'claude-opus-5[1m]'), ['high', 'max']);
});

test('cachedEffortLevels: a dotted or -latest spelling finds its row (mirrors the Mac\'s normalizedId)', async () => {
  const { cachedEffortLevels } = await import('../llm_agent/sdk/models.mjs');
  const rows = [
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: ['low', 'medium', 'high'] },
  ];
  await listSdkModels('u-norm', { queryFn: () => ({ supportedModels: async () => rows, close() {} }) });
  assert.deepEqual(cachedEffortLevels('u-norm', 'claude-sonnet-5.5'), ['low', 'medium', 'high']);
  assert.deepEqual(cachedEffortLevels('u-norm', 'claude-sonnet-5-5-latest'), ['low', 'medium', 'high']);
  assert.deepEqual(cachedEffortLevels('u-norm', 'claude-sonnet-5'), [], 'a different model is still unlisted');
});
