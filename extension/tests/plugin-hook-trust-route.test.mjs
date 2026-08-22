// The hook-trust endpoint. Trusting hooks authorizes shell execution, so the
// route validates hard, audits the grant, and refuses to trust a plugin that
// declares no hooks (or isn't installed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-trust-route-'));
const pluginDir = path.join(tmp, 'plugins');
fs.mkdirSync(pluginDir, { recursive: true });
process.env.LLMIDE_PLUGIN_DIR = pluginDir;
const tmpDb = path.join(__dirname, '_plugin-hook-trust-route-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

function vendorPlugin(name, { withHook = true } = {}) {
  const dir = path.join(pluginDir, name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }), 'utf8');
  if (withHook) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] },
    }), 'utf8');
  }
}
vendorPlugin('hooked');
vendorPlugin('plain', { withHook: false });

const { reloadPlugins, listInstalledPlugins } = await import('../llm_agent/skills/index.mjs');
const { setEnabled, listHooksTrusted, setHooksTrusted } = await import('../plugins/state.mjs');
const { setPluginHookTrust: setTrustRaw } = await import('../plugins/hook-trust.mjs');
reloadPlugins();

// The route injects the registry view (plugins/ may not import llm_agent/).
const listPlugins = (userId) => listInstalledPlugins(userId).plugins;
const setPluginHookTrust = (userId, name, trusted) =>
  setTrustRaw(userId, name, trusted, { listPlugins });

test('the plugins payload reports hook declarations and trust state', () => {
  setEnabled('u', 'hooked', true);
  const listed = listInstalledPlugins('u').plugins;
  const hooked = listed.find((p) => p.name === 'hooked');
  assert.equal(hooked.hookCount, 1);
  assert.equal(hooked.hooksTrusted, false, 'never trusted by default');
  const plain = listed.find((p) => p.name === 'plain');
  assert.equal(plain.hookCount, 0);
});

test('trust can be granted and revoked for a hook-declaring plugin', () => {
  assert.deepEqual(setPluginHookTrust('u', 'hooked', true), { ok: true, hooksTrusted: true });
  assert.equal(listHooksTrusted('u').has('hooked'), true);
  assert.deepEqual(setPluginHookTrust('u', 'hooked', false), { ok: true, hooksTrusted: false });
  assert.equal(listHooksTrusted('u').has('hooked'), false);
});

test('a plugin that declares no hooks cannot be granted hook trust', () => {
  const result = setPluginHookTrust('u', 'plain', true);
  assert.equal(result.ok, undefined);
  assert.match(result.error, /declares no hooks/);
  assert.equal(listHooksTrusted('u').has('plain'), false);
});

test('an unknown plugin cannot be granted hook trust', () => {
  const result = setPluginHookTrust('u', 'ghost', true);
  assert.equal(result.ok, undefined);
  assert.match(result.error, /not installed/);
});

test('revoking trust always works, even for a plugin that is already gone', () => {
  setHooksTrusted('u', 'ghost', true);   // e.g. trusted before an uninstall
  assert.deepEqual(setPluginHookTrust('u', 'ghost', false), { ok: true, hooksTrusted: false });
  assert.equal(listHooksTrusted('u').has('ghost'), false);
});

// The payload must say WHICH mechanism will deliver this plugin, or the UI
// cannot honestly describe what its hooks will do: natively the SDK runs every
// handler type it supports, translated only `command` ones.
test('the payload reports native delivery per plugin, following trust and the pref', async () => {
  const { setUserPrefs } = await import('../kb/user.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { id } = registerUser(getDb(), {
    email: 'delivery@example.com', password: 'pw-12345678', displayName: 'D',
  });

  setEnabled(id, 'hooked', true);
  const untrusted = listInstalledPlugins(id).plugins.find((p) => p.name === 'hooked');
  assert.equal(untrusted.nativeDelivery, false, 'an untrusted plugin is handed over by neither route');

  setPluginHookTrust(id, 'hooked', true);
  const trusted = listInstalledPlugins(id).plugins.find((p) => p.name === 'hooked');
  assert.equal(trusted.nativeDelivery, true);

  setUserPrefs(id, { nativePlugins: false });
  const translated = listInstalledPlugins(id).plugins.find((p) => p.name === 'hooked');
  assert.equal(translated.nativeDelivery, false, 'the pref falls back to translation');

  // A hookless plugin still goes native — that is how its commands and agents
  // reach the engine — and needs no trust for it.
  setUserPrefs(id, { nativePlugins: true });
  setEnabled(id, 'plain', true);
  const plain = listInstalledPlugins(id).plugins.find((p) => p.name === 'plain');
  assert.equal(plain.nativeDelivery, true);
});
