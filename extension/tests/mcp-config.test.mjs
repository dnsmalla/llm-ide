// extension/tests/mcp-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const { writeMcpRegistry, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');
const { buildMcpConfigForUser, effectiveMcpServers, credentialMissing } = await import('../mcp/mcp-config.mjs');

const noRestrict = () => false;
const planMode = () => true; // restrictsTools('plan') === true

function reg(plugin) { writeMcpRegistry([plugin]); }

test('null when no plugins, none enabled, none consented, or restricted mode', () => {
  writeMcpRegistry([]);
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null);

  reg({ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'claude', builtin: false });
  // registered but not enabled/consented
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null);
  setConsented('u', 'slack', true);
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null); // not enabled
  setEnabledMcp('u', 'slack', true);
  // restricted mode blocks it even when enabled+consented
  assert.equal(buildMcpConfigForUser('u', { mode: 'plan', restrictsToolsFn: planMode }), null);
});

test('returns the .mcp.json JSON for enabled+consented plugins on an unrestricted mode', () => {
  reg({ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 't' }, source: 'claude', builtin: false });
  setConsented('u', 'slack', true);
  setEnabledMcp('u', 'slack', true);
  const cfg = buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict });
  assert.ok(cfg);
  const parsed = JSON.parse(cfg.mcpConfigJson);
  assert.deepEqual(parsed.mcpServers.slack, { command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 't' } });
  assert.equal(cfg.allowed, true);
});


// ── Hosted (http/sse) transport ───────────────────────────────────────────
// The registry was stdio-only, so none of the servers coders actually reach
// for (GitHub, Sentry, Notion — all remote now) could be registered at all.

test('a hosted plugin is emitted in the CLI\'s http shape, not as a command', () => {
  writeMcpRegistry([{
    id: 'sentry', name: 'Sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp',
    source: 'catalog', builtin: false,
  }]);
  setConsented('u', 'sentry', true);
  setEnabledMcp('u', 'sentry', true);
  const servers = effectiveMcpServers('u');
  assert.deepEqual(servers.sentry, { type: 'http', url: 'https://mcp.sentry.dev/mcp' });
  assert.ok(!('command' in servers.sentry), 'a hosted server has no command');
});

test('an sse plugin keeps its own type', () => {
  writeMcpRegistry([{ id: 'streamy', name: 'S', transport: 'sse', url: 'https://x.test/sse', source: 'manual', builtin: false }]);
  setConsented('u', 'streamy', true); setEnabledMcp('u', 'streamy', true);
  assert.equal(effectiveMcpServers('u').streamy.type, 'sse');
});

test('a record with no transport field is still stdio (pre-transport registries)', () => {
  writeMcpRegistry([{ id: 'old', name: 'Old', command: 'uvx', args: ['x'], source: 'claude', builtin: false }]);
  setConsented('u', 'old', true); setEnabledMcp('u', 'old', true);
  assert.deepEqual(effectiveMcpServers('u').old, { command: 'uvx', args: ['x'] });
});

// ── Vault-held credentials ────────────────────────────────────────────────
// The registry file is shared across users and only redacted on read, so a
// catalog server's token lives in the vault and is injected here — the one
// place it appears in the emitted config.

test('a header credential is injected from the reader, through its template', () => {
  writeMcpRegistry([{
    id: 'github', name: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    credential: { vaultKey: 'mcp.github.token', target: 'header', name: 'Authorization', template: 'Bearer ${value}' },
    source: 'catalog', builtin: false,
  }]);
  setConsented('u', 'github', true); setEnabledMcp('u', 'github', true);

  const readSecret = (k) => (k === 'mcp.github.token' ? 'ghp_abc' : '');
  assert.equal(effectiveMcpServers('u', { readSecret }).github.headers.Authorization, 'Bearer ghp_abc');

  // No stored value → the header is omitted entirely rather than sent as a
  // bare "Bearer ", so the server reports a real auth error.
  const servers = effectiveMcpServers('u', { readSecret: () => '' });
  assert.equal(servers.github.headers, undefined);
  // …and the plugin is still offered, flagged so the client can say what to fix.
  assert.equal(credentialMissing({ credential: { vaultKey: 'mcp.github.token' } }, () => ''), true);
  assert.equal(credentialMissing({ credential: { vaultKey: 'mcp.github.token' } }, () => 'x'), false);
  assert.equal(credentialMissing({ id: 'no-cred' }, () => ''), false, 'a plugin with no credential is never "missing" one');
});

test('an env credential lands in env, alongside any env the record already had', () => {
  writeMcpRegistry([{
    id: 'airtable', name: 'Airtable', transport: 'stdio', command: 'npx', args: ['-y', 'airtable-mcp-server'],
    env: { EXISTING: 'keep' },
    credential: { vaultKey: 'mcp.airtable.apiKey', target: 'env', name: 'AIRTABLE_API_KEY' },
    source: 'catalog', builtin: false,
  }]);
  setConsented('u', 'airtable', true); setEnabledMcp('u', 'airtable', true);
  const env = effectiveMcpServers('u', { readSecret: () => 'key123' }).airtable.env;
  assert.deepEqual(env, { EXISTING: 'keep', AIRTABLE_API_KEY: 'key123' });
});

test('a throwing reader degrades to no credential instead of breaking every other server', () => {
  writeMcpRegistry([
    { id: 'needs-cred', name: 'A', transport: 'stdio', command: 'x', credential: { vaultKey: 'mcp.a.token', target: 'env', name: 'T' }, source: 'catalog', builtin: false },
    { id: 'plain', name: 'B', transport: 'stdio', command: 'y', source: 'manual', builtin: false },
  ]);
  for (const id of ['needs-cred', 'plain']) { setConsented('u', id, true); setEnabledMcp('u', id, true); }
  const servers = effectiveMcpServers('u', { readSecret: () => { throw new Error('vault down'); } });
  assert.equal(servers['needs-cred'].env, undefined);
  assert.equal(servers.plain.command, 'y', 'the unrelated server is unaffected');
});

test('buildMcpConfigForUser threads readSecret down to the emitted config', () => {
  writeMcpRegistry([{
    id: 'github', name: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
    credential: { vaultKey: 'mcp.github.token', target: 'header', name: 'Authorization', template: 'Bearer ${value}' },
    source: 'catalog', builtin: false,
  }]);
  setConsented('u', 'github', true); setEnabledMcp('u', 'github', true);
  const cfg = buildMcpConfigForUser('u', {
    mode: 'execute', restrictsToolsFn: noRestrict, readSecret: () => 'tok',
  });
  assert.match(cfg.mcpConfigJson, /Bearer tok/);
});
