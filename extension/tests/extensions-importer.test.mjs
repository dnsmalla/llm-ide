// The importer reads today's three state files into catalog items and changes
// none of them. Synthetic fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorld } from './helpers/extensions-world.mjs';

const world = createWorld({ tag: 'ext-importer' });
const { freshDb } = await import('./provider-test-env.mjs');
const { populateWorld } = await import('./helpers/extensions-populate.mjs');
const { users: [u1, u2, u3] } = freshDb(3);
await populateWorld(world, [u1, u2, u3]);
const { importCatalogItems } = await import('../llm_agent/extensions/importer.mjs');
const { loadedPlugins } = await import('../llm_agent/skills/registry.mjs');
const store = await import('../llm_agent/extensions/store.mjs');
const pluginState = await import('../plugins/state.mjs');
const sourceState = await import('../llm-sources/state.mjs');
const mcp = await import('../mcp/state.mjs');

const plugins = loadedPlugins();
const byId = (res) => Object.fromEntries(res.items.map((i) => [i.id, i]));

function stateFiles() {
  const dir = path.dirname(world.pluginDir);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => [f, createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]);
}

test('plugins: enabled, members, executables and trust import with their legacy meaning', () => {
  const res = importCatalogItems(u1, { plugins });
  assert.deepEqual(res.warnings, []);
  const items = byId(res);
  const alpha = items['plugin:local/alpha'];
  assert.equal(alpha.state.enabled, true);
  assert.deepEqual(alpha.members.map((m) => m.memberId).sort(),
    ['agent:helper', 'command:cmd-a', 'mcp:srv', 'skill:sk-one', 'skill:sk-two']);
  assert.equal(alpha.publisher.trust, 'local');
  assert.deepEqual(alpha.state.disabledMembers, []);
  const hooky = items['plugin:local/hooky'];
  assert.equal(hooky.state.consents.hooksTrusted, true);
  assert.ok(hooky.members.some((m) => m.memberId === 'hook:hooks' && m.executable));
  assert.deepEqual(hooky.declared.executableKinds, ['hooks']);
  assert.equal(items['plugin:local/codexy'].state.consents.hooksTrusted, false);
  // the same plugins read as off for a user who enabled none
  const none = byId(importCatalogItems(u3, { plugins }));
  assert.equal(none['plugin:local/alpha'].state.enabled, false);
  assert.equal(none['plugin:local/alpha'].legacy.enabled, false);
});

test('llm sources: enabled sources and per-item unchecked sets become members off', () => {
  const items = byId(importCatalogItems(u1, { plugins }));
  const builtin = items['llm-source:local/builtin'];
  assert.equal(builtin.state.enabled, true);
  assert.deepEqual(builtin.state.disabledMembers, ['skill:beta']);
  assert.ok(builtin.members.some((m) => m.memberId === 'skill:alpha'));
  assert.equal(items['llm-source:local/extra'].state.enabled, true);
  // a first-time user has the builtin source on by default and nothing unchecked
  const first = byId(importCatalogItems(u3, { plugins }));
  assert.equal(first['llm-source:local/builtin'].state.enabled, true);
  assert.equal(first['llm-source:local/extra'].state.enabled, false);
  assert.deepEqual(first['llm-source:local/builtin'].state.disabledMembers, []);
});

test('mcp servers: active only when enabled AND consented; a plugin-declared one also needs its plugin', () => {
  const items = byId(importCatalogItems(u1, { plugins }));
  assert.equal(items['mcp:local/linear'].state.enabled, true);
  assert.equal(items['mcp:local/sentry'].consents, undefined);
  assert.equal(items['mcp:local/sentry'].state.consents.transport, 'http');
  assert.equal(items['mcp:local/unused'].state.enabled, false, 'consented but never enabled');
  assert.equal(items['mcp:local/unused'].state.consents.consented, true);
  assert.equal(items['mcp:local/alpha-srv'].state.enabled, true);
  // switch its plugin off in the legacy file: the server goes dark with it
  pluginState.setEnabled(u1, 'alpha', false);
  assert.equal(byId(importCatalogItems(u1, { plugins }))['mcp:local/alpha-srv'].state.enabled, false);
  pluginState.setEnabled(u1, 'alpha', true);
});

test('two users never see each other\'s state', () => {
  const a = byId(importCatalogItems(u1, { plugins }));
  const b = byId(importCatalogItems(u2, { plugins }));
  assert.equal(a['plugin:local/alpha'].state.enabled, true);
  assert.equal(b['plugin:local/alpha'].state.enabled, false);
  assert.equal(b['plugin:local/owned'].state.enabled, true);
  assert.equal(b['mcp:local/linear'].state.enabled, false);
});

test('importing is idempotent and writes nothing', () => {
  const before = stateFiles();
  const first = importCatalogItems(u1, { plugins });
  const second = importCatalogItems(u1, { plugins });
  assert.deepEqual(first, second);
  assert.deepEqual(stateFiles(), before, 'no state file was created or changed');
  assert.ok(!fs.existsSync(store.storeFilePath()), 'the overlay file is not created by a read');
});

test('the overlay restricts: an item or member switched off there reads as off', () => {
  store.setItemEnabled(u1, 'plugin:local/hooky', false);
  store.setMembersEnabled(u1, 'plugin:local/alpha', ['skill:sk-one'], false);
  store.setMembersEnabled(u1, 'llm-source:local/builtin', ['skill:alpha'], false);
  store.setItemEnabled(u1, 'mcp:local/linear', false);
  const items = byId(importCatalogItems(u1, { plugins }));
  assert.equal(items['plugin:local/hooky'].state.enabled, false);
  assert.equal(items['plugin:local/hooky'].legacy.enabled, true, 'the legacy fact is still reported');
  assert.deepEqual(items['plugin:local/alpha'].state.disabledMembers, ['skill:sk-one']);
  assert.deepEqual(items['llm-source:local/builtin'].state.disabledMembers, ['skill:alpha', 'skill:beta']);
  assert.equal(items['mcp:local/linear'].state.enabled, false);
  assert.equal(importCatalogItems(u2, { plugins }).items.find((i) => i.id === 'mcp:local/linear').state.enabled, false);
  store.forgetUser(u1);
});

test('state corruption costs a section, never the import, and never reads as "on"', () => {
  const dir = path.dirname(world.pluginDir);
  const files = ['plugin-state.json', 'llm-sources-state.json', 'mcp-plugins-state.json', 'mcp-plugins.json', 'llm-sources.json', 'plugin-sources.json'];
  const saved = new Map(files.filter((f) => fs.existsSync(path.join(dir, f))).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
  try {
    for (const garbage of ['{ not json', '[]', 'null', '"str"', '{"u":{"enabled":"yes","hooksTrusted":5}}']) {
      for (const f of files) fs.writeFileSync(path.join(dir, f), garbage);
      const res = importCatalogItems(u1, { plugins });
      assert.ok(Array.isArray(res.items), garbage);
      const items = byId(res);
      assert.ok(!Object.values(items).some((i) => i.state.enabled && i.kind !== 'llm-source'), `${garbage}: plugins and mcp read as off`);
    }
    // a corrupt overlay is reported and fails closed
    for (const [f, buf] of saved) fs.writeFileSync(path.join(dir, f), buf);
    fs.writeFileSync(store.storeFilePath(), '{ nope');
    const res = importCatalogItems(u1, { plugins });
    assert.equal(res.corrupt, true);
    assert.ok(res.warnings.some((w) => /unreadable/.test(w)));
    assert.ok(res.items.every((i) => i.state.enabled === false));
  } finally {
    for (const [f, buf] of saved) fs.writeFileSync(path.join(dir, f), buf);
    fs.rmSync(store.storeFilePath(), { force: true });
  }
  assert.equal(byId(importCatalogItems(u1, { plugins }))['plugin:local/alpha'].state.enabled, true, 'restored state imports again');
  assert.ok(sourceState && mcp, 'modules loaded');
});

test('a recorded plugin source gives a pinned item and the publisher it names', () => {
  const dir = path.dirname(world.pluginDir);
  const file = path.join(dir, 'plugin-sources.json');
  const sha = 'b'.repeat(40);
  fs.writeFileSync(file, JSON.stringify({
    alpha: { kind: 'git', url: 'https://github.com/anthropics/skills', ref: 'main', commit: sha },
    hooky: { kind: 'git', url: 'https://github.com/obra/superpowers', commit: sha },
    owned: { kind: 'git', url: 'http://insecure.example.com/x', commit: sha },
  }));
  try {
    const res = importCatalogItems(u1, { plugins });
    const items = byId(res);
    assert.equal(items['plugin:anthropics/alpha'].publisher.trust, 'official');
    assert.equal(items['plugin:anthropics/alpha'].source.commit, sha);
    assert.equal(items['plugin:obra/hooky'].publisher.trust, 'unknown');
    // an invalid record never becomes a pinned item; it is reported and the plugin stays importable as local
    assert.ok(res.warnings.some((w) => /owned.*recorded source ignored/.test(w)));
    assert.equal(items['plugin:local/owned'].source.kind, 'local');
    assert.equal(items['plugin:local/owned'].state.enabled, true);
  } finally { fs.rmSync(file, { force: true }); }
});
