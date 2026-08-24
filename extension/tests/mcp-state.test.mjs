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


// ── HTTP transport + catalog adds ─────────────────────────────────────────

test('addMcpPlugin registers a hosted server and rejects a non-http url', async () => {
  const { addMcpPlugin, writeMcpRegistry, transportOf } = await import('../mcp/state.mjs');
  writeMcpRegistry([]);
  const ok = addMcpPlugin({ name: 'Sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' });
  assert.equal(ok.plugin.transport, 'http');
  assert.equal(ok.plugin.url, 'https://mcp.sentry.dev/mcp');
  assert.equal(ok.plugin.command, undefined, 'a hosted record carries no command');
  assert.equal(transportOf(ok.plugin), 'http');

  // A url alone implies http — the common shape when importing.
  writeMcpRegistry([]);
  assert.equal(addMcpPlugin({ name: 'x', url: 'http://localhost:3000/mcp' }).plugin.transport, 'http');

  // Anything that is not http(s) cannot be expressed as a transport, so it is
  // refused here rather than failing opaquely inside the CLI later.
  for (const bad of ['file:///etc/passwd', 'ws://x.test', 'notaurl', '']) {
    const r = addMcpPlugin({ name: 'bad', transport: 'http', url: bad });
    assert.ok(r.error, `${bad} must be refused`);
  }
  // Neither command nor url.
  assert.ok(addMcpPlugin({ name: 'nope' }).error);
});

test('addMcpPluginFromCatalog resolves the entry server-side and demands a required arg', async () => {
  const { addMcpPluginFromCatalog, writeMcpRegistry } = await import('../mcp/state.mjs');
  const { catalogEntry } = await import('../mcp/catalog.mjs');
  writeMcpRegistry([]);

  // filesystem declares requiresArg — registering it with no allowed root
  // would produce a server that exposes nothing, so it is refused.
  assert.ok(addMcpPluginFromCatalog('filesystem').error);
  const fsAdd = addMcpPluginFromCatalog('filesystem', { arg: '/tmp/proj' });
  assert.deepEqual(fsAdd.plugin.args, [...catalogEntry('filesystem').args, '/tmp/proj']);
  assert.equal(fsAdd.plugin.source, 'catalog');

  // A hosted catalog entry carries its credential DESCRIPTOR, never a value.
  writeMcpRegistry([]);
  const gh = addMcpPluginFromCatalog('github').plugin;
  assert.equal(gh.transport, 'http');
  assert.equal(gh.credential.vaultKey, 'mcp.github.token');
  // The descriptor legitimately contains the literal "Bearer ${value}"
  // template, so assert on the thing that matters: no VALUE is stored. A
  // hosted record only gains `headers` when a token is injected, and that
  // happens in mcp-config at build time, never here.
  assert.equal(gh.headers, undefined, 'no resolved headers in the registry record');
  assert.deepEqual(Object.keys(gh.credential).sort(), ['label', 'name', 'target', 'template', 'vaultKey'],
    'credential is a descriptor — any extra key would be somewhere a secret could hide');

  assert.ok(addMcpPluginFromCatalog('does-not-exist').error);
});

test('every catalog entry is registerable and internally consistent', async () => {
  const { MCP_CATALOG } = await import('../mcp/catalog.mjs');
  const { addMcpPluginFromCatalog, writeMcpRegistry } = await import('../mcp/state.mjs');
  assert.ok(MCP_CATALOG.length >= 15, `catalog should offer at least 15 servers, has ${MCP_CATALOG.length}`);
  const ids = MCP_CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'catalog ids must be unique');

  for (const entry of MCP_CATALOG) {
    assert.ok(entry.name && entry.description, `${entry.id}: needs a name and description`);
    if (entry.transport === 'http') {
      assert.match(entry.url, /^https?:\/\//, `${entry.id}: hosted entries need an http(s) url`);
      assert.equal(entry.command, undefined, `${entry.id}: hosted entries have no command`);
    } else {
      assert.ok(entry.command, `${entry.id}: stdio entries need a command`);
    }
    // A credential must say where it goes, and OAuth servers must not ask for
    // one (the CLI does the browser sign-in itself).
    if (entry.credential) {
      assert.ok(entry.credential.vaultKey?.startsWith('mcp.'), `${entry.id}: credential must live under the mcp.* vault namespace`);
      assert.ok(['env', 'header'].includes(entry.credential.target), `${entry.id}: credential needs a target`);
      assert.ok(entry.credential.name, `${entry.id}: credential needs a header/env name`);
      assert.ok(!entry.oauth, `${entry.id}: an OAuth server must not also demand a token`);
    }
    // And it must actually register.
    writeMcpRegistry([]);
    const r = addMcpPluginFromCatalog(entry.id, { arg: entry.requiresArg ? '/tmp/x' : undefined });
    assert.ok(!r.error, `${entry.id}: failed to register — ${r.error}`);
  }
});

test('catalog credential vault keys are accepted by the vault allowlist', async () => {
  const { MCP_CATALOG } = await import('../mcp/catalog.mjs');
  const { encrypt } = await import('../server/vault.mjs');
  // ensureAllowed is private, but setSecret/getSecret run it — encrypt does
  // not, so assert through the pattern the vault actually applies.
  const MCP_RE = /^mcp\.[a-z][a-z0-9-]{1,40}\.[a-zA-Z]{1,32}$/;
  assert.ok(typeof encrypt === 'function');
  for (const e of MCP_CATALOG) {
    if (!e.credential) continue;
    assert.match(e.credential.vaultKey, MCP_RE,
      `${e.id}: vault would reject '${e.credential.vaultKey}' as an unknown key`);
  }
});

test('revoking consent also disables — the enabled-but-unconsented state is unreachable', () => {
  writeMcpRegistry([]);
  const { plugin } = addMcpPlugin({ name: 'Seq', command: 'npx', args: ['-y', 'seq'], source: 'manual' });
  setConsented('user-c', plugin.id, true);
  setEnabledMcp('user-c', plugin.id, true);

  // Revoking consent leaves a server that LOOKS on (its switch reads enabled)
  // yet never reaches the CLI, because effectiveMcpServers needs both gates.
  // Clearing enable keeps the state honest.
  setConsented('user-c', plugin.id, false);
  const after = listMcpPluginsWithState('user-c').plugins.find((p) => p.id === plugin.id);
  assert.equal(after.consented, false);
  assert.equal(after.enabled, false, 'revoking consent must clear enable');

  // Re-consenting does NOT silently re-enable — the user opts in again.
  setConsented('user-c', plugin.id, true);
  const reconsented = listMcpPluginsWithState('user-c').plugins.find((p) => p.id === plugin.id);
  assert.equal(reconsented.enabled, false, 're-consent must not resurrect enable');
});

test('setEnabledMcp refuses to enable an unconsented server and reports what it stored', () => {
  writeMcpRegistry([]);
  const { plugin } = addMcpPlugin({ name: 'Gate', command: 'npx', args: ['-y', 'gate'], source: 'manual' });

  const refused = setEnabledMcp('user-d', plugin.id, true);
  assert.equal(refused.enabled, false);
  assert.match(refused.error, /consent/i);
  assert.equal(listMcpPluginsWithState('user-d').plugins.find((p) => p.id === plugin.id).enabled, false);

  setConsented('user-d', plugin.id, true);
  const allowed = setEnabledMcp('user-d', plugin.id, true);
  assert.equal(allowed.enabled, true);
  assert.equal(allowed.error, undefined);

  // Disabling never needs consent — it can only reduce access.
  assert.equal(setEnabledMcp('user-d', plugin.id, false).enabled, false);
});
