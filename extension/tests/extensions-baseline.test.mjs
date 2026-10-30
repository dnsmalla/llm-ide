// P0 of the extensions catalog (docs/superpowers/plans/2026-10-31-extensions-catalog.md):
// pin what every extension consumer loads TODAY, for a synthetic world of
// plugins, LLM sources and MCP servers, so each later phase can prove "no
// change when the flag is off".
//
// Golden file: tests/fixtures/extensions-baseline/baseline.json. It must only
// change on purpose; regenerate with LLMIDE_REGEN_FIXTURES=1 and review the diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './helpers/extensions-world.mjs';

const world = createWorld({ tag: 'ext-baseline' });
const { freshDb } = await import('./provider-test-env.mjs');
const { snapshotConsumers } = await import('./helpers/extensions-snapshot.mjs');

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extensions-baseline', 'baseline.json');

const { users: [u1, u2, u3] } = freshDb(3);
const { populateWorld } = await import('./helpers/extensions-populate.mjs');
const pluginState = await import('../plugins/state.mjs');
const mcp = await import('../mcp/state.mjs');

await populateWorld(world, [u1, u2, u3]);

const WHO = { u1, u2, u3 };

async function currentSnapshot() {
  const out = {};
  for (const [role, id] of Object.entries(WHO)) out[role] = await snapshotConsumers(world, id);
  return out;
}

test('baseline: what each consumer loads matches the committed golden file', async () => {
  const snap = await currentSnapshot();
  if (process.env.LLMIDE_REGEN_FIXTURES === '1' || !fs.existsSync(GOLDEN)) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
  }
  assert.deepEqual(snap, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});

test('baseline shape sanity (guards the golden file against being regenerated empty)', async () => {
  const snap = await currentSnapshot();
  // u1: native plugins are alpha + hooky (trusted); codexy declares hooks but holds no grant, so it runs nowhere.
  assert.deepEqual(snap.u1.pluginDelivery.native.sort(), ['alpha', 'hooky']);
  assert.deepEqual(snap.u1.pluginDelivery.translated, []);
  assert.equal(snap.u1.pluginDelivery.sdkPlugins.length, 2);
  assert.deepEqual(Object.keys(snap.u1.skillSet.commands).sort(), ['cmd-a', 'own-cmd']);
  assert.ok(snap.u1.library.includes('skills/alpha') && !snap.u1.library.includes('skills/beta'), 'the unchecked skill is absent');
  assert.ok(snap.u1.library.includes('skills/delta'), 'second source contributes');
  assert.deepEqual(Object.keys(snap.u1.mcp.execute.servers).sort(), ['alpha-srv', 'linear', 'sentry']);
  assert.deepEqual(snap.u1.mcp.plan, { servers: {}, allowedTools: [] }, 'restricted modes load no MCP');
  assert.deepEqual(snap.u2.pluginDelivery.sdkPlugins, []);
  assert.deepEqual(snap.u2.mcp.execute.servers, {});
  assert.ok(snap.u3.library.includes('skills/alpha'), 'a first-time user gets the builtin source on');
  assert.ok(!snap.u3.library.includes('skills/delta'));
});

// Adapter turns today: no extensions of any kind reach a provider-backed turn.
test('baseline: a provider-adapter turn reports no MCP servers and mounts no mcp__ tool', async () => {
  const conns = await import('../server/provider-connections.mjs');
  const { runProviderTurn } = await import('../llm_agent/adapter/provider-turn.mjs');
  const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
  const { fakeFetch, jsonResponse } = await import('./provider-test-env.mjs');
  // freshDb resets the DB, so the user ids above are gone; this user gets its own extension state.
  const { db, users: [a] } = freshDb(1);
  conns.connectProvider(a, { catalogId: 'groq', apiKey: 'sk-turn-0123456789abcdef' }, db);
  conns.updateSettings(a, { toolsEnabled: true }, db);
  pluginState.setEnabled(a, 'alpha', true);
  for (const id of ['linear', 'alpha-srv']) { mcp.setConsented(a, id, true); mcp.setEnabledMcp(a, id, true); }
  const usage = { inputTokens: { total: 3 }, outputTokens: { total: 1 } };
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'hi' }, { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ] }) }),
  });
  const fetchImpl = fakeFetch(() => jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile' }] }));
  for (const mode of ['execute', 'ask']) {
    const evs = [];
    await runProviderTurn({
      userId: a, provider: 'custom:cat-groq', model: 'llama-3.3-70b-versatile', message: 'hello', mode,
      onEvent: (e) => evs.push(e), deps: { db, fetchImpl, modelFor: () => model },
    });
    const init = evs.find((e) => e.type === 'init');
    assert.deepEqual(init.mcpServers, [], mode);
    assert.ok(init.tools.length > 0 && !init.tools.some((t) => t.startsWith('mcp__')), mode);
  }
});
