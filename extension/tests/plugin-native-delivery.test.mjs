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

// Hooks the loader cannot translate still run if the SDK loads the package, so
// they must count as hooks for the trust gate.
makePlugin('unsupportedhook');
fs.mkdirSync(path.join(pluginDir, 'unsupportedhook', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'unsupportedhook', 'hooks', 'hooks.json'), JSON.stringify({
  hooks: { SomeFutureEvent: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] },
}), 'utf8');
makePlugin('httphook');
fs.mkdirSync(path.join(pluginDir, 'httphook', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'httphook', 'hooks', 'hooks.json'), JSON.stringify({
  hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/x' }] }] },
}), 'utf8');
// Beyond hooks the SDK also runs monitors (unsandboxed background scripts),
// starts LSP servers and puts bin/ on PATH — all of it must wait for trust.
makePlugin('monitorsonly');
fs.mkdirSync(path.join(pluginDir, 'monitorsonly', 'monitors'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'monitorsonly', 'monitors', 'monitors.json'),
  JSON.stringify([{ name: 'watch', command: 'tail -f /dev/null', description: 'x', when: 'always' }]), 'utf8');
makePlugin('lsponly');
fs.writeFileSync(path.join(pluginDir, 'lsponly', '.lsp.json'),
  JSON.stringify({ ts: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } } }), 'utf8');
makePlugin('inlinelsp');
fs.writeFileSync(path.join(pluginDir, 'inlinelsp', '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'inlinelsp', version: '1.0.0',
  lspServers: { ts: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } } },
}), 'utf8');
makePlugin('bincontent');
fs.mkdirSync(path.join(pluginDir, 'bincontent', 'bin'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'bincontent', 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
makePlugin('modulesonly');
fs.mkdirSync(path.join(pluginDir, 'modulesonly', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'modulesonly', 'hooks', 'hooks.json'),
  JSON.stringify({ hooks: {}, modules: ['./h.mjs'] }), 'utf8');
makePlugin('expmonitors');
fs.writeFileSync(path.join(pluginDir, 'expmonitors', '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'expmonitors', version: '1.0.0',
  experimental: { monitors: [{ name: 'w', command: 'echo hi', description: 'x', when: 'always' }] },
}), 'utf8');
makePlugin('codexmonitors', { vendor: 'codex' });
fs.mkdirSync(path.join(pluginDir, 'codexmonitors', 'monitors'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'codexmonitors', 'monitors', 'monitors.json'),
  JSON.stringify([{ name: 'w', command: 'echo hi', description: 'x', when: 'always' }]), 'utf8');
makePlugin('emptymonitors');
fs.mkdirSync(path.join(pluginDir, 'emptymonitors', 'monitors'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'emptymonitors', 'monitors', 'monitors.json'), '[]', 'utf8');
makePlugin('brokenmonitors');
fs.mkdirSync(path.join(pluginDir, 'brokenmonitors', 'monitors'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'brokenmonitors', 'monitors', 'monitors.json'), '{ not json', 'utf8');
makePlugin('emptyhooks');
fs.mkdirSync(path.join(pluginDir, 'emptyhooks', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'emptyhooks', 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }), 'utf8');
makePlugin('emptyinline');
fs.writeFileSync(path.join(pluginDir, 'emptyinline', '.claude-plugin', 'plugin.json'),
  JSON.stringify({ name: 'emptyinline', version: '1.0.0', hooks: {} }), 'utf8');
makePlugin('inlinehook');
fs.writeFileSync(path.join(pluginDir, 'inlinehook', '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'inlinehook', version: '1.0.0',
  hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] },
}), 'utf8');

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

for (const name of ['monitorsonly', 'lsponly', 'inlinelsp', 'bincontent', 'brokenmonitors', 'modulesonly', 'expmonitors']) {
  test(`'${name}': an executable component beyond hooks needs trust before the SDK loads it`, () => {
    enable(`u-${name}`, name);
    assert.deepEqual(buildUserPluginDelivery(`u-${name}`, { nativeEnabled: true }).sdkPlugins, [],
      'the SDK would arm/start it on its own');
    setHooksTrusted(`u-${name}`, name, true);
    assert.deepEqual(buildUserPluginDelivery(`u-${name}`, { nativeEnabled: true }).native, [name]);
  });
}

test('the plugin list names WHICH executable components a plugin declares', async () => {
  const { listInstalledPlugins } = await import('../llm_agent/skills/registry.mjs');
  const byName = Object.fromEntries(listInstalledPlugins('u-list').plugins.map((p) => [p.name, p]));
  assert.deepEqual(byName.monitorsonly.executableKinds, ['monitors']);
  assert.deepEqual(byName.lsponly.executableKinds, ['lsp']);
  assert.deepEqual(byName.inlinelsp.executableKinds, ['lsp']);
  assert.deepEqual(byName.bincontent.executableKinds, ['bin']);
  assert.deepEqual(byName.hookedclaude.executableKinds, ['hooks']);
  assert.deepEqual(byName.plainclaude.executableKinds, []);
  assert.equal(byName.monitorsonly.declaresHooks, true, 'wire flag means ANY executable component');
  assert.deepEqual(byName.expmonitors.executableKinds, ['monitors'], 'experimental.monitors is what the SDK reads');
  assert.deepEqual(byName.modulesonly.executableKinds, ['hooks'], 'hooks.json modules are plugin code');
  // The SDK never loads a Codex-layout package, so monitors there are inert and
  // must not be claimed (or gated) as if the agent engine would run them.
  assert.deepEqual(byName.codexmonitors.executableKinds, []);
});

for (const name of ['emptyhooks', 'emptyinline', 'emptymonitors']) {
  test(`'${name}': a plugin that declares no handler is not stranded behind a trust grant`, () => {
    enable(`u-${name}`, name);
    const d = buildUserPluginDelivery(`u-${name}`, { nativeEnabled: true });
    assert.deepEqual(d.native, [name], 'nothing to trust, so it goes native without it');
  });
}

for (const name of ['unsupportedhook', 'httphook', 'inlinehook']) {
  test(`'${name}': hooks llm-ide cannot translate still need trust before going native`, () => {
    enable(`u-${name}`, name);
    const d = buildUserPluginDelivery(`u-${name}`, { nativeEnabled: true });
    assert.deepEqual(d.sdkPlugins, [], 'the SDK would run what the loader dropped');
    setHooksTrusted(`u-${name}`, name, true);
    assert.deepEqual(buildUserPluginDelivery(`u-${name}`, { nativeEnabled: true }).native, [name]);
  });
}

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
