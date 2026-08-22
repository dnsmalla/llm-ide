// Plugin-declared MCP servers: how a vendor plugin's `.mcp.json` becomes
// consent-gated registry entries, and how those entries stay tied to the
// plugin's own lifecycle (uninstall removes them; a per-user plugin toggle
// gates them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-plugsrv-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const {
  writeMcpRegistry, readMcpRegistry, syncPluginMcpServers,
  setConsented, setEnabledMcp, listMcpPluginsWithState,
} = await import('../mcp/state.mjs');
const { effectiveMcpServers } = await import('../mcp/mcp-config.mjs');

const decl = (name, extra = {}) => ({ name, transport: 'stdio', command: 'npx', args: ['-y', name], ...extra });

test('sync registers one entry per declaration, scoped to its plugin', () => {
  writeMcpRegistry([]);
  const result = syncPluginMcpServers([
    { pluginName: 'reviewer', servers: [decl('linear'), decl('sentry')] },
  ]);
  assert.equal(result.added, 2);
  const list = readMcpRegistry();
  assert.equal(list.length, 2);
  for (const entry of list) {
    assert.equal(entry.source, 'plugin');
    assert.equal(entry.pluginName, 'reviewer');
    assert.match(entry.id, /^reviewer-/);
  }
});

test('a plugin server starts unconsented and unenabled for every user', () => {
  writeMcpRegistry([]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  const { plugins } = listMcpPluginsWithState('u');
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].consented, false, 'a plugin must never bring consent with it');
  assert.equal(plugins[0].enabled, false);
});

test('sync is idempotent and preserves the id (and thus per-user state)', () => {
  writeMcpRegistry([]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  const id = readMcpRegistry()[0].id;
  setConsented('u', id, true);
  setEnabledMcp('u', id, true);

  const again = syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  assert.equal(again.added, 0);
  assert.equal(readMcpRegistry().length, 1);
  assert.equal(readMcpRegistry()[0].id, id, 'a stable id keeps the user consent that was granted to it');
  const { plugins } = listMcpPluginsWithState('u');
  assert.equal(plugins[0].consented, true);
  assert.equal(plugins[0].enabled, true);
});

test('sync updates a changed declaration in place', () => {
  writeMcpRegistry([]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear', { args: ['-y', 'linear@2'] })] }]);
  const list = readMcpRegistry();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].args, ['-y', 'linear@2']);
});

test('an uninstalled plugin loses its servers; manual entries are untouched', () => {
  writeMcpRegistry([{ id: 'mine', name: 'Mine', command: 'srv', args: [], source: 'manual', builtin: false }]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  assert.equal(readMcpRegistry().length, 2);
  const result = syncPluginMcpServers([]);   // plugin uninstalled
  assert.equal(result.removed, 1);
  assert.deepEqual(readMcpRegistry().map((p) => p.id), ['mine']);
});

test('a plugin server is only effective while its plugin is enabled for that user', () => {
  writeMcpRegistry([]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  const id = readMcpRegistry()[0].id;
  setConsented('u', id, true);
  setEnabledMcp('u', id, true);

  // Plugin disabled for this user → the server is not in the effective set,
  // even though the server itself is enabled and consented.
  assert.deepEqual(effectiveMcpServers('u', { pluginEnabled: () => false }), {});
  assert.deepEqual(Object.keys(effectiveMcpServers('u', { pluginEnabled: () => true })), [id]);
});

test('without a pluginEnabled predicate, plugin servers stay out of the config', () => {
  writeMcpRegistry([]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [decl('linear')] }]);
  const id = readMcpRegistry()[0].id;
  setConsented('u', id, true);
  setEnabledMcp('u', id, true);
  // A caller that cannot answer "is this plugin enabled?" must not get the
  // server: silently including it would ignore the plugin toggle entirely.
  assert.deepEqual(effectiveMcpServers('u'), {});
});
