// P2: with LLMIDE_EXT_ACTIVE_SET on, the SDK plugin delivery, the skill set, the
// skill library ('/' menu and load-skill) and the user MCP builder read the
// catalog's switches. Two promises:
//   1. flag off = exactly today (the golden file from extensions-baseline), and
//      flag on with nothing switched off = the same bytes;
//   2. flag on, an item or member the catalog switched off never loads.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './helpers/extensions-world.mjs';

const world = createWorld({ tag: 'ext-consumers' });
const { freshDb } = await import('./provider-test-env.mjs');
const { populateWorld } = await import('./helpers/extensions-populate.mjs');
const { snapshotConsumers } = await import('./helpers/extensions-snapshot.mjs');
const { users: [u1, u2, u3] } = freshDb(3);
await populateWorld(world, [u1, u2, u3]);
const registry = await import('../llm_agent/skills/registry.mjs');
const skills = await import('../llm_agent/skills/index.mjs');
const engine = await import('../llm_agent/sdk/engine.mjs');
const store = await import('../llm_agent/extensions/store.mjs');
const pluginState = await import('../plugins/state.mjs');
const { handleLoadSkill } = await import('../llm_agent/tools/handlers/load-skill.mjs');
const { _resetGateWarningForTests } = await import('../llm_agent/extensions/gate.mjs');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'fixtures', 'extensions-baseline', 'baseline.json'), 'utf8'));
const noRestrict = () => false;
const flagOn = () => { process.env.LLMIDE_EXT_ACTIVE_SET = '1'; };
const flagOff = () => { delete process.env.LLMIDE_EXT_ACTIVE_SET; };
const mcpNow = (u) => Object.keys(engine.buildUserMcpServers(u, 'execute', { restrictsToolsFn: noRestrict, readSecret: () => '' }).servers).sort();
const delivery = (u) => registry.buildUserPluginDelivery(u, { nativeEnabled: true, cwd: world.root });
const libraryIds = (u) => { skills._resetSkillLibraryCache(); return skills.listSkillLibrary(u).skills.map((s) => s.id).sort(); };

afterEach(() => {
  flagOff();
  for (const u of [u1, u2, u3]) store.forgetUser(u);
  fs.rmSync(store.storeFilePath(), { force: true });
  skills._resetSkillLibraryCache();
  _resetGateWarningForTests();
});

test('flag off with a catalog overlay present: exactly today (the overlay is not read by any consumer)', async () => {
  store.setItemEnabled(u1, 'plugin:local/hooky', false);
  store.setItemEnabled(u1, 'mcp:local/linear', false);
  store.setMembersEnabled(u1, 'llm-source:local/builtin', ['skill:alpha'], false);
  assert.deepEqual(await snapshotConsumers(world, u1), GOLDEN.u1);
});

test('flag on, nothing switched off: byte-identical to the baseline for every user', async () => {
  flagOn();
  for (const [role, id] of Object.entries({ u1, u2, u3 })) {
    assert.deepEqual(await snapshotConsumers(world, id), GOLDEN[role], role);
  }
});

test('flag on: a plugin switched off is not delivered, has no skills, commands or declared MCP server', () => {
  store.setItemEnabled(u1, 'plugin:local/alpha', false);
  assert.deepEqual(delivery(u1).native, ['alpha', 'hooky'], 'flag off: still loaded');
  flagOn();
  assert.deepEqual(delivery(u1).native, ['hooky']);
  const set = registry.buildPerUserSkillSet(u1);
  assert.ok(!set.skills.has('sk-one') && !set.skills.has('sk-two'));
  assert.ok(!set.commands.has('cmd-a') && !set.subagents.has('helper'));
  assert.ok(set.skills.has('hk-skill'), 'its siblings are untouched');
  assert.ok(!mcpNow(u1).includes('alpha-srv'), 'its declared server goes dark with it');
  assert.deepEqual(mcpNow(u1), ['linear', 'sentry']);
});

test('flag on: an unchecked skill/command/agent is absent from the set AND from the SDK plugin view', () => {
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one', 'command:cmd-a', 'agent:helper'], false);
  flagOn();
  const set = registry.buildPerUserSkillSet(u1);
  assert.ok(!set.skills.has('sk-one') && set.skills.has('sk-two'));
  assert.ok(!set.commands.has('cmd-a') && !set.subagents.has('helper'));
  const d = delivery(u1);
  const alpha = d.sdkPlugins.find((p) => p.path.includes('alpha'));
  assert.ok(alpha, 'alpha is still delivered');
  assert.notEqual(alpha.path, path.join(world.pluginDir, 'alpha'), 'a generated view, not the full directory');
  assert.equal(alpha.skipMcpDiscovery, true);
  const files = (rel) => fs.existsSync(path.join(alpha.path, rel));
  assert.ok(files('.claude-plugin/plugin.json'), 'manifest copied');
  assert.ok(!files('skills/sk-one') && files('skills/sk-two/SKILL.md'));
  assert.ok(!files('commands/cmd-a.md') && !files('agents/helper.md'));
  assert.ok(!files('.mcp.json'), 'the SDK must not rediscover servers');
  // the original directory is never modified
  assert.ok(fs.existsSync(path.join(world.pluginDir, 'alpha', 'skills', 'sk-one', 'SKILL.md')));
  // idempotent: the same choices give the same path, another user's view is separate
  assert.equal(delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha')).path, alpha.path);
  store.setMembersEnabled(u2, 'plugin:local/alpha', ['skill:sk-two'], false);
  pluginState.setEnabled(u2, 'alpha', true);
  const other = registry.buildUserPluginDelivery(u2, { nativeEnabled: true }).sdkPlugins.find((p) => p.path.includes('alpha'));
  assert.notEqual(other.path, alpha.path);
  assert.ok(fs.existsSync(path.join(other.path, 'skills', 'sk-one', 'SKILL.md')) && !fs.existsSync(path.join(other.path, 'skills', 'sk-two')));
});

test('flag on: re-checking a member restores the full directory; a plugin update gets a fresh view', async () => {
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
  flagOn();
  const first = delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha')).path;
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], true);
  assert.equal(delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha')).path, path.join(world.pluginDir, 'alpha'));
  // switch off again after the plugin's files changed: a new view, the old one pruned
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
  const skillFile = path.join(world.pluginDir, 'alpha', 'skills', 'sk-two', 'SKILL.md');
  fs.writeFileSync(path.join(world.pluginDir, 'alpha', 'commands', 'new-cmd.md'), '---\ndescription: d\n---\nx\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(world.pluginDir, 'alpha', 'commands'), later, later);
  fs.utimesSync(skillFile, later, later);
  registry.reloadPlugins();
  const second = delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha')).path;
  assert.notEqual(second, first);
  assert.ok(fs.existsSync(path.join(second, 'commands', 'new-cmd.md')));
  assert.ok(!fs.existsSync(first), 'the stale view was removed');
  fs.rmSync(path.join(world.pluginDir, 'alpha', 'commands', 'new-cmd.md'));
  registry.reloadPlugins();
});

test('flag on: unchecking the hooks component drops the hooks and the trust requirement for that plugin', () => {
  store.setMembersEnabled(u1, 'plugin:local/hooky', ['hook:hooks'], false);
  flagOn();
  const d = delivery(u1);
  const hooky = d.sdkPlugins.find((p) => p.path.includes('hooky'));
  assert.ok(hooky, 'still delivered (it has a skill)');
  assert.ok(!fs.existsSync(path.join(hooky.path, 'hooks')), 'no hooks directory in the view');
  assert.ok(fs.existsSync(path.join(hooky.path, 'skills', 'hk-skill', 'SKILL.md')));
});

test('flag on: a user who never trusted a plugin\'s hooks gets it once the hooks are unchecked, never before', () => {
  pluginState.setEnabled(u3, 'hooky', true);   // enabled, hooks NOT trusted
  assert.deepEqual(delivery(u3).native, [], 'flag off: held back until trusted');
  flagOn();
  assert.deepEqual(delivery(u3).native, [], 'flag on, hooks still checked: held back');
  store.setMembersEnabled(u3, 'plugin:local/hooky', ['hook:hooks'], false);
  const d = delivery(u3);
  assert.deepEqual(d.native, ['hooky']);
  assert.ok(!fs.existsSync(path.join(d.sdkPlugins[0].path, 'hooks')));
  pluginState.setEnabled(u3, 'hooky', false);
});

test('flag on: a plugin the view cannot filter exactly is NOT delivered (a switched-off member must never load)', () => {
  const manifest = path.join(world.pluginDir, 'alpha', '.claude-plugin', 'plugin.json');
  const original = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'alpha', version: '1.0.0', skills: './skills' }));
  registry.reloadPlugins();
  try {
    store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
    flagOn();
    const excluded = [];
    const d = registry.buildUserPluginDelivery(u1, { nativeEnabled: true, onExcluded: (e) => excluded.push(e) });
    assert.ok(!d.native.includes('alpha'));
    assert.equal(excluded.length, 1);
    assert.match(excluded[0].reason, /relocates skills/);
    flagOff();
    assert.ok(registry.buildUserPluginDelivery(u1, { nativeEnabled: true }).native.includes('alpha'), 'flag off: untouched');
  } finally {
    fs.writeFileSync(manifest, original);
    registry.reloadPlugins();
  }
});

test('flag on: symlinks inside a plugin are never copied into a view', () => {
  const secret = path.join(world.root, 'outside-secret.txt');
  fs.writeFileSync(secret, 'secret');
  const link = path.join(world.pluginDir, 'alpha', 'leak.txt');
  fs.symlinkSync(secret, link);
  try {
    store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
    flagOn();
    const alpha = delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha'));
    assert.ok(!fs.existsSync(path.join(alpha.path, 'leak.txt')) && !fs.lstatSync(alpha.path).isSymbolicLink());
  } finally { fs.rmSync(link, { force: true }); }
});

test('flag on: the skill library, "/" menu and load-skill honour a switched-off skill or source', async () => {
  store.setMembersEnabled(u1, 'llm-source:local/builtin', ['skill:alpha'], false);
  const before = libraryIds(u1);
  assert.ok(before.includes('skills/alpha'), 'flag off: still listed');
  assert.ok(skills.readSkillInstructions('skills/alpha', u1));
  flagOn();
  const ids = libraryIds(u1);
  assert.ok(!ids.includes('skills/alpha') && ids.includes('runtime/gamma') && ids.includes('skills/delta'));
  assert.equal(skills.readSkillInstructions('skills/alpha', u1), null, 'the id is no longer readable');
  const miss = await handleLoadSkill({ id: 'skills/alpha' }, { userId: u1 });
  assert.equal(miss.error, 'unknown skill id');
  assert.ok(!miss.available.includes('skills/alpha'), 'and it is not offered back');
  assert.ok((await handleLoadSkill({ id: 'runtime/gamma' }, { userId: u1 })).content.includes('gamma'));
  // another user is unaffected
  assert.ok(libraryIds(u3).includes('skills/alpha'));
  // a whole source off: none of its skills
  store.setItemEnabled(u1, 'llm-source:local/extra', false);
  assert.ok(!libraryIds(u1).includes('skills/delta'));
  assert.ok(libraryIds(u1).includes('runtime/gamma'));
});

test('flag on: a catalog switch-off lets a same-id skill from a later source stand in (the legacy dedupe order)', () => {
  // delta also exists in a second extra source: switching it off in `extra` must surface the other copy
  const dup = path.join(world.root, 'dup-source');
  fs.mkdirSync(path.join(dup, 'skills', 'delta'), { recursive: true });
  fs.writeFileSync(path.join(dup, 'skills', 'delta', 'SKILL.md'), '---\nname: delta\ndescription: dup delta\n---\n\nbody\n');
  fs.writeFileSync(path.join(dup, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  return import('../llm-sources/registry.mjs').then(async (src) => {
    const state = await import('../llm-sources/state.mjs');
    const list = src.readRegistry();
    src.writeRegistry([...list, { id: 'dup', name: 'Dup', origin: 'local', location: dup }]);
    state.setEnabled(u1, 'dup', true);
    try {
      store.setMembersEnabled(u1, 'llm-source:local/extra', ['skill:delta'], false);
      flagOn();
      skills._resetSkillLibraryCache();
      const hit = skills.listSkillLibrary(u1).skills.find((s) => s.id === 'skills/delta');
      assert.equal(hit?.sourceId, 'dup');
    } finally {
      src.writeRegistry(src.readRegistry().filter((s) => s.id !== 'dup'));
    }
  });
});

test('flag on: an MCP server switched off, or whose plugin member is unchecked, is not mounted', () => {
  assert.deepEqual(mcpNow(u1), ['alpha-srv', 'linear', 'sentry']);
  store.setItemEnabled(u1, 'mcp:local/linear', false);
  assert.deepEqual(mcpNow(u1), ['alpha-srv', 'linear', 'sentry'], 'flag off: still mounted');
  flagOn();
  assert.deepEqual(mcpNow(u1), ['alpha-srv', 'sentry']);
  const r = engine.buildUserMcpServers(u1, 'execute', { restrictsToolsFn: noRestrict, readSecret: () => '' });
  assert.deepEqual(r.allowedTools.sort(), ['mcp__alpha-srv', 'mcp__sentry'], 'and it is not pre-approved either');
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['mcp:srv'], false);
  assert.deepEqual(mcpNow(u1), ['sentry']);
});

test('flag on: restricted modes still load no MCP, and the catalog cannot ADD a server the legacy rules refuse', () => {
  flagOn();
  assert.deepEqual(engine.buildUserMcpServers(u1, 'plan', { restrictsToolsFn: () => true }).servers, {});
  // an explicit "enabled" in the overlay for an unconsented server changes nothing (restrict-only until P4)
  store.setItemEnabled(u1, 'mcp:local/unused', true);
  assert.ok(!mcpNow(u1).includes('unused'));
  store.setItemEnabled(u3, 'plugin:local/alpha', true);
  assert.deepEqual(delivery(u3).native, []);
});

test('flag on: an unreadable catalog state file fails closed (nothing loads); flag off is unaffected', async () => {
  fs.writeFileSync(store.storeFilePath(), '{ broken');
  flagOn();
  assert.deepEqual(delivery(u1).sdkPlugins, []);
  assert.deepEqual(mcpNow(u1), []);
  assert.deepEqual(libraryIds(u1), []);
  assert.equal(registry.buildPerUserSkillSet(u1).commands.size, 0);
  flagOff();
  assert.deepEqual(await snapshotConsumers(world, u1), GOLDEN.u1);
});

test('two users: one user\'s switches never reach another', () => {
  store.setItemEnabled(u1, 'plugin:local/owned', false);
  store.setItemEnabled(u1, 'mcp:local/sentry', false);
  flagOn();
  assert.ok(!registry.buildPerUserSkillSet(u1).skills.has('owned-skill'));
  assert.ok(registry.buildPerUserSkillSet(u2).skills.has('owned-skill'));
  assert.deepEqual(mcpNow(u2), []);
});

test('flag on: the extensions-state file is the only thing read; legacy files are never written', () => {
  const dir = path.dirname(world.pluginDir);
  const stamp = () => Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]));
  const before = stamp();
  flagOn();
  delivery(u1); registry.buildPerUserSkillSet(u1); libraryIds(u1); mcpNow(u1);
  assert.deepEqual(stamp(), before);
});

test('flag on: editing a skill file in place (no directory mtime change) gives a fresh view; views are created private', () => {
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
  flagOn();
  const first = delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha')).path;
  assert.equal(fs.statSync(path.dirname(first)).mode & 0o077, 0, 'the per-user views folder is owner-only');
  const file = path.join(world.pluginDir, 'alpha', 'skills', 'sk-two', 'SKILL.md');
  const original = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, `${original}\nedited in place\n`);
    const later = new Date(Date.now() + 9000);
    fs.utimesSync(file, later, later);
    registry.reloadPlugins();
    const second = delivery(u1).sdkPlugins.find((p) => p.path.includes('alpha')).path;
    assert.notEqual(second, first);
    assert.match(fs.readFileSync(path.join(second, 'skills', 'sk-two', 'SKILL.md'), 'utf8'), /edited in place/);
  } finally {
    fs.writeFileSync(file, original);
    registry.reloadPlugins();
  }
});
