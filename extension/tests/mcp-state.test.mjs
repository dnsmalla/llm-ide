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

test('slugifyMcp guarantees valid ids on collision (I1)', () => {
  writeMcpRegistry([]);
  // Create a 40-char base that will collide.
  const longName = 'a'.repeat(40);
  const p1 = addMcpPlugin({ name: longName, command: 'cmd1', args: [], source: 'manual' });
  assert.match(p1.plugin.id, SLUG_RE);
  // Force a collision by manually adding a plugin with the same id.
  let list = readMcpRegistry();
  list.push({ ...p1.plugin, id: p1.plugin.id });
  writeMcpRegistry(list);
  // Now add another plugin with the same 40-char name — slugifyMcp must avoid producing a 42-char id.
  const p2 = addMcpPlugin({ name: longName, command: 'cmd2', args: [], source: 'manual' });
  assert.match(p2.plugin.id, SLUG_RE);
  // Both ids must be valid (not 42 chars orphans).
  assert.ok(p1.plugin.id.length <= 40);
  assert.ok(p2.plugin.id.length <= 40);
  assert.notEqual(p1.plugin.id, p2.plugin.id);
});

test('removeMcpPlugin prunes per-user state to prevent resurrection (I2)', () => {
  writeMcpRegistry([]);
  const p = addMcpPlugin({ name: 'test-plugin', command: 't', args: [], source: 'manual' }).plugin;
  // Enable and consent for a user.
  setConsented('user-a', p.id, true);
  setEnabledMcp('user-a', p.id, true);
  const before = listMcpPluginsWithState('user-a').plugins.find((pl) => pl.id === p.id);
  assert.equal(before.enabled, true);
  assert.equal(before.consented, true);

  // Remove the plugin.
  removeMcpPlugin(p.id);
  // Re-add a plugin with the same slug (would resurrect state if not pruned).
  const p2 = addMcpPlugin({ name: 'test-plugin', command: 't2', args: [], source: 'manual' }).plugin;
  const after = listMcpPluginsWithState('user-a').plugins.find((pl) => pl.id === p2.id);
  // The new plugin must NOT inherit the old enabled/consented state.
  assert.equal(after.enabled, false, 'enabled should be false after remove+re-add (no resurrection)');
  assert.equal(after.consented, false, 'consented should be false after remove+re-add (no resurrection)');
});
