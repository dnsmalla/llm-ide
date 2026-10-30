// P1: computeActiveSet + the shadow compare. The active set is built from the
// SAME builders the consumers use, forced through the catalog gate, so with an
// empty overlay it must equal what the legacy consumers load, for every user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/extensions-world.mjs';

const world = createWorld({ tag: 'ext-active' });
const { freshDb } = await import('./provider-test-env.mjs');
const { populateWorld } = await import('./helpers/extensions-populate.mjs');
const { users: [u1, u2, u3] } = freshDb(3);
await populateWorld(world, [u1, u2, u3]);
const registry = await import('../llm_agent/skills/registry.mjs');
const skills = await import('../llm_agent/skills/index.mjs');
const { buildUserMcpServers } = await import('../llm_agent/extensions/mcp-servers.mjs');
const { computeActiveSet, summarizeActiveSet } = await import('../llm_agent/extensions/active-set.mjs');
const { importCatalogItems } = await import('../llm_agent/extensions/importer.mjs');
const { makeGate } = await import('../llm_agent/extensions/gate.mjs');
const shadow = await import('../llm_agent/extensions/shadow.mjs');
const store = await import('../llm_agent/extensions/store.mjs');
const flags = await import('../llm_agent/extensions/flags.mjs');

const noRestrict = () => false;
const legacy = (userId, mode = 'execute') => {
  const d = registry.buildUserPluginDelivery(userId, { nativeEnabled: true, gate: null });
  const set = registry.buildPerUserSkillSet(userId, { gate: null });
  const mcp = buildUserMcpServers(userId, mode, { gate: null, restrictsToolsFn: noRestrict, readSecret: () => '' });
  return {
    native: [...d.native].sort(),
    pluginSkills: [...set.skills].filter(([, s]) => s.pluginName).map(([n, s]) => `${s.pluginName}/${n}`).sort(),
    commands: [...set.commands].map(([t, c]) => `${c.pluginName}/${t}`).sort(),
    subagents: [...set.subagents].map(([n, s]) => `${s.pluginName}/${n}`).sort(),
    library: skills.listSkillLibrary(userId, { gate: null }).skills.map((s) => s.id).sort(),
    mcp: Object.keys(mcp.servers).sort(),
  };
};
const active = (userId, mode = 'execute') => computeActiveSet(userId, mode, { readSecret: () => '', restrictsToolsFn: noRestrict });
const view = (a) => ({
  native: [...a.nativePlugins].sort(),
  pluginSkills: a.pluginSkills.map((s) => `${s.plugin}/${s.name}`).sort(),
  commands: a.commands.map((c) => `${c.plugin}/${c.trigger}`).sort(),
  subagents: a.subagents.map((s) => `${s.plugin}/${s.name}`).sort(),
  library: a.skills.map((s) => s.id).sort(),
  mcp: Object.keys(a.mcpServers).sort(),
});

test('with an empty overlay the active set equals what the legacy builders load, for every user', () => {
  for (const u of [u1, u2, u3]) assert.deepEqual(view(active(u)), legacy(u), u);
  assert.ok(view(active(u1)).mcp.includes('alpha-srv') && view(active(u1)).native.length === 2);
});

test('restricted modes load no MCP, in the active set as in the legacy builder', () => {
  const a = computeActiveSet(u1, 'plan', { readSecret: () => '', restrictsToolsFn: () => true });
  assert.deepEqual(a.mcpServers, {});
  assert.deepEqual(a.allowedTools, []);
});

test('the importer\'s active items and the gate agree (one meaning of "on")', () => {
  store.setItemEnabled(u1, 'plugin:local/hooky', false);
  store.setItemEnabled(u1, 'mcp:local/sentry', false);
  store.setMembersEnabled(u1, 'llm-source:local/builtin', ['skill:alpha'], false);
  try {
    const gate = makeGate(u1);
    const items = Object.fromEntries(importCatalogItems(u1, { plugins: registry.loadedPlugins() }).items.map((i) => [i.id, i]));
    assert.equal(gate.pluginActive('hooky'), items['plugin:local/hooky'].state.enabled && true);
    assert.equal(gate.pluginActive('alpha'), items['plugin:local/alpha'].state.enabled);
    assert.equal(gate.mcpActive('sentry'), false);
    assert.equal(items['mcp:local/sentry'].state.enabled, false);
    assert.equal(gate.librarySkillActive('builtin', 'alpha'), false);
    assert.equal(gate.librarySkillActive('builtin', 'gamma'), true);
    assert.ok(items['llm-source:local/builtin'].state.disabledMembers.includes('skill:alpha'));
  } finally { store.forgetUser(u1); }
});

test('fingerprint: stable, per user, and changes with the set (not with order or time)', () => {
  const a = active(u1);
  assert.equal(active(u1).fingerprint, a.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(active(u2).fingerprint, a.fingerprint);
  store.setItemEnabled(u1, 'mcp:local/linear', false);
  try {
    const b = active(u1);
    assert.notEqual(b.fingerprint, a.fingerprint);
    assert.equal(b.items.length, a.items.length - 1);
  } finally { store.forgetUser(u1); }
  assert.equal(active(u1).fingerprint, a.fingerprint, 'switching it back restores the same fingerprint');
});

test('the summary is counts only: no item name, path or credential reaches it', () => {
  const s = JSON.stringify(summarizeActiveSet(active(u1)));
  for (const secret of ['linear', 'alpha', 'sk-one', 'hooky', world.root, 'npx']) assert.ok(!s.includes(secret), secret);
  assert.deepEqual(Object.keys(JSON.parse(s)).sort(),
    ['commands', 'excluded', 'failClosed', 'fingerprint', 'items', 'mcpServers', 'pluginSkills', 'sdkPlugins', 'skills', 'subagents']);
});

test('shadow: equal when the overlay is empty; reports what the flag WOULD change when it is not', () => {
  process.env.LLMIDE_EXT_SHADOW = 'on';
  shadow._resetShadowForTests();
  try {
    const loaded = (u) => ({ nativePlugins: legacy(u).native, pluginSkills: legacy(u).pluginSkills, commands: legacy(u).commands, subagents: legacy(u).subagents, mcpServers: legacy(u).mcp });
    const opts = { computeOpts: { readSecret: () => '', restrictsToolsFn: noRestrict } };
    const r1 = shadow.runTurnShadow(u1, 'execute', loaded(u1), opts);
    assert.equal(r1.ok, true);
    assert.equal(r1.mismatches, 0);
    assert.equal(r1.flagOn, false);
    // once per user per day
    assert.equal(shadow.runTurnShadow(u1, 'execute', loaded(u1), opts), null);
    // a different user, and the next day, run again
    assert.equal(shadow.runTurnShadow(u2, 'execute', loaded(u2), opts).ok, true);
    const tomorrow = Date.now() + 36 * 3600 * 1000;
    store.setItemEnabled(u1, 'mcp:local/linear', false);
    store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
    const r2 = shadow.runTurnShadow(u1, 'execute', loaded(u1), { ...opts, now: tomorrow });
    assert.equal(r2.ok, false);
    assert.equal(r2.categories.mcpServers.onlyLegacy, 1, 'legacy still mounts linear; the active set would not');
    assert.equal(r2.categories.pluginSkills.onlyLegacy, 1);
    assert.equal(r2.categories.mcpServers.onlyActive, 0);
    assert.equal(shadow.lastShadowResult().mismatches, 2);
    // counts only: nothing identifying in the stored result
    const blob = JSON.stringify(r2);
    for (const secret of ['linear', 'sk-one', 'alpha', world.root]) assert.ok(!blob.includes(secret), secret);
  } finally { store.forgetUser(u1); delete process.env.LLMIDE_EXT_SHADOW; }
});

test('shadow never throws and is off under test unless asked for', () => {
  shadow._resetShadowForTests();
  assert.equal(flags.shadowEnabled(), false, 'NODE_ENV=test and no override');
  assert.equal(shadow.runTurnShadow(u1, 'execute', {}), null);
  process.env.LLMIDE_EXT_SHADOW = 'on';
  try {
    const boom = shadow.runTurnShadow(u3, 'execute', {}, { compute: () => { throw new Error('boom'); } });
    assert.equal(boom, null);
    process.env.LLMIDE_EXT_SHADOW = 'off';
    assert.equal(flags.shadowEnabled(), false);
  } finally { delete process.env.LLMIDE_EXT_SHADOW; }
});

test('flags: active set default off; adapter default on with =off as the kill switch', () => {
  assert.equal(flags.activeSetEnabled(), false);
  assert.equal(flags.adapterEnabled(), true);
  for (const [name, fn, onVals, offVals] of [
    ['LLMIDE_EXT_ACTIVE_SET', flags.activeSetEnabled, ['1', 'on', 'true', 'ON'], ['', '0', 'off', 'garbage']],
    ['LLMIDE_EXT_ADAPTER', flags.adapterEnabled, ['', '1', 'on', 'garbage'], ['off', 'OFF', '0', 'false']],
  ]) {
    for (const v of onVals) { process.env[name] = v; assert.equal(fn(), true, `${name}=${v}`); }
    for (const v of offVals) { process.env[name] = v; assert.equal(fn(), false, `${name}=${v}`); }
    delete process.env[name];
  }
});
