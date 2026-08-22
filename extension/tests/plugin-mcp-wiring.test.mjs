// The seam between the plugin registry and the MCP registry: reloading plugins
// must reconcile what their `.mcp.json` files declare, and the per-user
// predicate that gates those servers must follow the plugin's enable state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-wiring-'));
const pluginDir = path.join(tmp, 'plugins');
fs.mkdirSync(pluginDir, { recursive: true });
process.env.LLMIDE_PLUGIN_DIR = pluginDir;

const { readMcpRegistry, writeMcpRegistry } = await import('../mcp/state.mjs');
const { reloadPlugins, pluginEnabledFor } = await import('../llm_agent/skills/registry.mjs');
const { setEnabled: setPluginEnabled } = await import('../plugins/state.mjs');

function vendorPlugin(name, mcpServers) {
  const dir = path.join(pluginDir, name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }), 'utf8');
  if (mcpServers) fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers }), 'utf8');
  return dir;
}

test('reloadPlugins registers the servers a plugin declares', () => {
  writeMcpRegistry([]);
  vendorPlugin('reviewer', { linear: { command: 'npx', args: ['-y', 'linear'] } });
  reloadPlugins();
  const entries = readMcpRegistry();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'plugin');
  assert.equal(entries[0].pluginName, 'reviewer');
});

test('reloadPlugins drops the servers of a plugin that is gone', () => {
  fs.rmSync(path.join(pluginDir, 'reviewer'), { recursive: true, force: true });
  reloadPlugins();
  assert.deepEqual(readMcpRegistry(), []);
});

test('pluginEnabledFor follows the per-user plugin toggle', () => {
  writeMcpRegistry([]);
  vendorPlugin('reviewer', { linear: { command: 'npx' } });
  reloadPlugins();
  const gate = pluginEnabledFor('u');
  assert.equal(gate('reviewer'), false, 'a freshly installed plugin is off until enabled');
  setPluginEnabled('u', 'reviewer', true);
  assert.equal(pluginEnabledFor('u')('reviewer'), true);
  assert.equal(pluginEnabledFor('other')('reviewer'), false, 'enable state is per user');
  assert.equal(pluginEnabledFor('u')('never-installed'), false);
});
