// How an enabled plugin reaches the v2 engine. Two mechanisms, and a plugin
// uses exactly ONE of them:
//
//   native      — handed to the Agent SDK as a local plugin. The SDK loads its
//                 skills/commands/agents and runs its hooks itself, with full
//                 fidelity (every handler type and event it supports).
//   translated  — llm-ide runs the plugin's `command` hooks itself, bounded by
//                 its own timeout and output cap.
//
// Native is the default; turning it off falls back to translation. Either way
// hook trust is required before anything runs, and the SDK is never allowed to
// discover the plugin's MCP servers — those keep their own consent gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-delivery-'));
process.env.LLMIDE_DB_PATH = path.join(tmp, 'native-delivery-test.db');
const pluginDir = path.join(tmp, 'plugins');
fs.mkdirSync(pluginDir, { recursive: true });
process.env.LLMIDE_PLUGIN_DIR = pluginDir;

function makePlugin(name, { vendor = 'claude', hooks = false } = {}) {
  const dir = path.join(pluginDir, name);
  if (vendor === 'own') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }), 'utf8');
  } else {
    const sub = vendor === 'codex' ? '.codex-plugin' : '.claude-plugin';
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }), 'utf8');
  }
  if (hooks) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] },
    }), 'utf8');
  }
}

makePlugin('plainclaude');                              // vendor, no hooks
makePlugin('hookedclaude', { hooks: true });            // vendor, hooks
makePlugin('hookedcodex', { vendor: 'codex', hooks: true });
makePlugin('ownformat', { vendor: 'own' });

const { reloadPlugins, buildUserPluginDelivery } = await import('../llm_agent/skills/index.mjs');
const { setEnabled, setHooksTrusted } = await import('../plugins/state.mjs');
reloadPlugins();

function enable(userId, ...names) { for (const n of names) setEnabled(userId, n, true); }

test('nothing is delivered for a plugin the user has not enabled', () => {
  const d = buildUserPluginDelivery('nobody', { nativeEnabled: true });
  assert.deepEqual(d.sdkPlugins, []);
  assert.deepEqual(d.hooks, {});
});

test('a hookless Claude plugin is handed to the SDK, MCP discovery off', () => {
  enable('u1', 'plainclaude');
  const d = buildUserPluginDelivery('u1', { nativeEnabled: true });
  assert.equal(d.sdkPlugins.length, 1);
  assert.equal(d.sdkPlugins[0].type, 'local');
  assert.ok(d.sdkPlugins[0].path.endsWith('plainclaude'));
  // llm-ide owns MCP consent; the SDK must never connect a plugin's servers.
  assert.equal(d.sdkPlugins[0].skipMcpDiscovery, true);
  assert.deepEqual(d.native, ['plainclaude']);
});

test('an untrusted plugin with hooks is NOT handed over — the SDK would run them', () => {
  enable('u2', 'hookedclaude');
  const d = buildUserPluginDelivery('u2', { nativeEnabled: true });
  assert.deepEqual(d.sdkPlugins, [], 'handing it over would bypass the hook-trust gate');
  assert.deepEqual(d.hooks, {}, 'and it must not run through translation either');
});

test('a trusted plugin with hooks goes native, and is not also translated', () => {
  enable('u3', 'hookedclaude');
  setHooksTrusted('u3', 'hookedclaude', true);
  const d = buildUserPluginDelivery('u3', { nativeEnabled: true });
  assert.deepEqual(d.native, ['hookedclaude']);
  assert.deepEqual(d.hooks, {}, 'running both mechanisms would fire every hook twice');
  assert.deepEqual(d.translated, []);
});

test('with native off, a trusted plugin falls back to translated hooks', () => {
  enable('u4', 'hookedclaude');
  setHooksTrusted('u4', 'hookedclaude', true);
  const d = buildUserPluginDelivery('u4', { nativeEnabled: false });
  assert.deepEqual(d.sdkPlugins, []);
  assert.deepEqual(Object.keys(d.hooks), ['PreToolUse']);
  assert.deepEqual(d.translated, ['hookedclaude']);
});

test('a Codex-layout plugin is never handed over — the SDK cannot read it', () => {
  enable('u5', 'hookedcodex');
  setHooksTrusted('u5', 'hookedcodex', true);
  const d = buildUserPluginDelivery('u5', { nativeEnabled: true });
  assert.deepEqual(d.sdkPlugins, []);
  // It still gets its hooks, through translation — the fallback covers it.
  assert.deepEqual(d.translated, ['hookedcodex']);
  assert.deepEqual(Object.keys(d.hooks), ['PreToolUse']);
});

test('an own-format plugin keeps the existing path entirely', () => {
  enable('u6', 'ownformat');
  const d = buildUserPluginDelivery('u6', { nativeEnabled: true });
  assert.deepEqual(d.sdkPlugins, [], 'no vendor manifest for the SDK to read');
  assert.deepEqual(d.hooks, {});
});

test('native is the default when the caller says nothing', () => {
  enable('u7', 'plainclaude');
  assert.deepEqual(buildUserPluginDelivery('u7').native, ['plainclaude']);
});

// --- The pref that switches it ---

const { setUserPrefs, nativePluginsEnabled } = await import('../kb/user.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');

test('native delivery is on by default and the pref turns it off', () => {
  const { id } = registerUser(getDb(), {
    email: 'native@example.com', password: 'pw-12345678', displayName: 'N',
  });
  assert.equal(nativePluginsEnabled(id), true, 'unset means on');
  setUserPrefs(id, { nativePlugins: false });
  assert.equal(nativePluginsEnabled(id), false);
  setUserPrefs(id, { nativePlugins: true });
  assert.equal(nativePluginsEnabled(id), true);
});

test('an unknown user keeps the default rather than losing plugins', () => {
  assert.equal(nativePluginsEnabled('no-such-user'), true);
});
