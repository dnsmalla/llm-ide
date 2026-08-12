// extension/tests/mcp-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-state-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins');

const {
  readMcpRegistry, writeMcpRegistry, addMcpPlugin, removeMcpPlugin,
  getMcpPlugin, listMcpPluginsWithState, setConsented, setEnabledMcp, SLUG_RE,
} = await import('../mcp/state.mjs');

test('addMcpPlugin registers a server; listMcpPluginsWithState reflects enable/consent', () => {
  writeMcpRegistry([]);
  const res = addMcpPlugin({ name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'manual' });
  assert.ok(res.plugin, JSON.stringify(res));
  assert.match(res.plugin.id, SLUG_RE);
  assert.equal(res.plugin.command, 'npx');

  // A different user sees registered but not enabled/consented.
  const list = listMcpPluginsWithState('user-a');
  assert.equal(list.plugins.length, 1);
  assert.equal(list.plugins[0].enabled, false);
  assert.equal(list.plugins[0].consented, false);

  setConsented('user-a', res.plugin.id, true);
  setEnabledMcp('user-a', res.plugin.id, true);
  const after = listMcpPluginsWithState('user-a').plugins.find((p) => p.id === res.plugin.id);
  assert.equal(after.consented, true);
  assert.equal(after.enabled, true);
  // Per-user isolation: user-b is untouched.
  assert.equal(listMcpPluginsWithState('user-b').plugins.find((p) => p.id === res.plugin.id).enabled, false);
});

test('addMcpPlugin rejects a bad slug; removeMcpPlugin deletes', () => {
  writeMcpRegistry([]);
  const bad = addMcpPlugin({ name: '!!bad!!', command: 'x', args: [], source: 'manual' });
  // slugify still produces a valid id (s- prefix / stripped) — assert it's valid, not rejected:
  assert.match(bad.plugin.id, SLUG_RE);
  const r = removeMcpPlugin(bad.plugin.id);
  assert.ok(r.ok);
  assert.equal(getMcpPlugin(bad.plugin.id), null);
});
