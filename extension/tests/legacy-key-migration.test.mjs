// The one-time carry-over of existing provider keys into the catalog (K1 P6 upgrade path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './provider-test-env.mjs';

const { setSecret, getSecret } = await import('../server/vault.mjs');
const conns = await import('../server/provider-connections.mjs');
const { syncCustomProviders } = await import('../server/custom-providers.mjs');
const { migrateLegacyProviderKeys, migrationView, getMigrationRecord } = await import('../providers/legacy-key-migration.mjs');
const { logger } = await import('../core/logger.mjs');

const DS_KEY = 'sk-deepseek-0123456789abcdef';

test('a DeepSeek-only user ends with a working catalog connection, old key kept, tools NOT switched on but suggested', () => {
  const { db, users: [a] } = freshDb();
  setSecret(db, a, 'deepseek.apiKey', DS_KEY);
  const rec = migrateLegacyProviderKeys(a, { db });
  assert.deepEqual(rec.created.map((c) => c.provider), ['deepseek']);
  const c = conns.listConnections(a, db);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].provider, c[0].catalogId, c[0].hasKey, c[0].enabled], ['custom:cat-deepseek', 'deepseek', true, true]);
  assert.equal(getSecret(db, a, 'custom.cat-deepseek.apiKey'), DS_KEY, 'the key was copied into the connection slot');
  assert.equal(getSecret(db, a, 'deepseek.apiKey'), DS_KEY, 'the old key is untouched');
  assert.equal(conns.getSettings(a, db).toolsEnabled, false, 'the migration never enables tools by itself');
  assert.equal(migrationView(rec).toolsSuggested, true);
});

test('idempotent: a second run changes nothing, even after the user disconnects', () => {
  const { db, users: [a] } = freshDb();
  setSecret(db, a, 'deepseek.apiKey', DS_KEY);
  migrateLegacyProviderKeys(a, { db });
  conns.disconnectProvider(a, 'cat-deepseek', db);
  const again = migrateLegacyProviderKeys(a, { db });
  assert.equal(conns.listConnections(a, db).length, 0, 'a user who disconnected is not reconnected behind their back');
  assert.equal(again.created.length, 1, 'the stored record is returned unchanged');
});

test('an existing catalog connection for the provider is left alone', () => {
  const { db, users: [a] } = freshDb();
  setSecret(db, a, 'deepseek.apiKey', DS_KEY);
  conns.connectProvider(a, { catalogId: 'deepseek', apiKey: 'sk-other-0123456789abcdef' }, db);
  const rec = migrateLegacyProviderKeys(a, { db });
  assert.equal(rec.created.length, 0);
  assert.equal(getSecret(db, a, 'custom.cat-deepseek.apiKey'), 'sk-other-0123456789abcdef');
});

test("another user's keys and connections are untouched, and a user with no keys gets nothing", () => {
  const { db, users: [a, b] } = freshDb();
  setSecret(db, a, 'deepseek.apiKey', DS_KEY);
  migrateLegacyProviderKeys(a, { db });
  assert.equal(conns.listConnections(b, db).length, 0);
  const rec = migrateLegacyProviderKeys(b, { db });
  assert.deepEqual([rec.created.length, rec.needsReview.length, rec.toolsSuggested], [0, 0, false]);
  assert.equal(getSecret(db, b, 'custom.cat-deepseek.apiKey'), null);
  assert.equal(conns.getSettings(b, db).toolsEnabled, false, 'nothing migrated, nothing suggested or switched on');
});

test('an OpenAI-compatible custom provider becomes a generic connection; a base URL the guard refuses is "needs review"', () => {
  const { db, users: [a] } = freshDb();
  syncCustomProviders([
    { id: 'relay1', name: 'Relay', baseURL: 'https://relay.example.com/v1', apiKey: 'custom.relay1.apiKey' },
    { id: 'lan1', name: 'Lab box', baseURL: 'http://192.168.1.20:8080/v1', apiKey: 'custom.lan1.apiKey' },
    { id: 'anthro', name: 'Not compat', baseURL: 'https://x.example.com/v1', apiKey: 'custom.anthro.apiKey', isOpenAICompatible: false },
  ], a, db);
  for (const id of ['relay1', 'lan1', 'anthro']) setSecret(db, a, `custom.${id}.apiKey`, `sk-${id}-0123456789abcdef`);
  const rec = migrateLegacyProviderKeys(a, { db });
  assert.deepEqual(rec.created.map((c) => c.name), ['Relay']);
  assert.deepEqual(rec.needsReview.map((r) => r.name), ['Lab box']);
  assert.match(rec.needsReview[0].reason, /https|private|address|allowed/i);
  const c = conns.listConnections(a, db);
  assert.equal(c.length, 1);
  assert.equal(c[0].catalogId, 'openai-compatible');
  assert.equal(c[0].baseURL, 'https://relay.example.com/v1');
  assert.ok(!JSON.stringify(migrationView(rec)).includes('sk-'), 'the public view carries no key');
});

test('a failure for one provider does not block the others, and the key is never logged', () => {
  const { db, users: [a] } = freshDb();
  syncCustomProviders([{ id: 'bad', name: 'Bad', baseURL: 'https://169.254.169.254/v1', apiKey: 'custom.bad.apiKey' }], a, db);
  setSecret(db, a, 'custom.bad.apiKey', 'sk-secretbad-0123456789abcdef');
  setSecret(db, a, 'deepseek.apiKey', DS_KEY);
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  const grab = (chunk) => { lines.push(String(chunk)); return true; };
  process.stderr.write = grab; process.stdout.write = grab;
  let rec;
  try { rec = migrateLegacyProviderKeys(a, { db }); } finally { process.stderr.write = orig; process.stdout.write = origOut; }
  assert.deepEqual(rec.created.map((c) => c.provider), ['deepseek']);
  assert.deepEqual(rec.needsReview.map((r) => r.provider), ['custom:bad']);
  const all = lines.join('') + JSON.stringify(rec) + JSON.stringify(getMigrationRecord(a, db));
  assert.ok(!all.includes('sk-secretbad-0123456789abcdef') && !all.includes(DS_KEY), 'no key in logs or the stored record');
  void logger;
});

test('after the migration a DeepSeek-only user can chat in ask mode with no tools; a tool mode needs the visible switch', async () => {
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  const { runProviderTurn, ProviderTurnError } = await import('../llm_agent/adapter/provider-turn.mjs');
  const { _clearModelCacheForTests } = await import('../providers/provider-models.mjs');
  const { fakeFetch, jsonResponse } = await import('./provider-test-env.mjs');
  const { db, users: [a] } = freshDb();
  _clearModelCacheForTests();
  setSecret(db, a, 'deepseek.apiKey', DS_KEY);
  migrateLegacyProviderKeys(a, { db });
  const usage = { inputTokens: { total: 5 }, outputTokens: { total: 2 } };
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
    { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'hi' }, { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }] }) }) });
  const run = (mode) => {
    const evs = [];
    return runProviderTurn({ userId: a, provider: 'custom:cat-deepseek', model: 'deepseek-chat', message: 'hello', mode, agentContext: {}, onEvent: (e) => evs.push(e),
      deps: { db, fetchImpl: fakeFetch(() => jsonResponse({ data: [{ id: 'deepseek-chat' }] })), modelFor: () => model } }).then((out) => ({ out, evs }));
  };
  const ask = await run('ask');
  assert.ok(ask.evs.some((e) => e.type === 'result'));
  assert.deepEqual(ask.evs.find((e) => e.type === 'init').tools, []);
  await assert.rejects(run('execute'), (e) => e instanceof ProviderTurnError && e.code === 'PROVIDER_TOOLS_DISABLED');
  conns.updateSettings(a, { toolsEnabled: true }, db);
  const exec = await run('execute');
  assert.ok(exec.evs.find((e) => e.type === 'init').tools.length > 0, 'one visible switch later, tools are mounted');
});
