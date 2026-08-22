// The engine seam: a turn only carries hooks from plugins that are BOTH
// enabled for the user and hook-trusted by them.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-hooks-'));
const pluginDir = path.join(tmp, 'plugins');
fs.mkdirSync(pluginDir, { recursive: true });
process.env.LLMIDE_PLUGIN_DIR = pluginDir;
const tmpDb = path.join(__dirname, '_agent-v2-hooks-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

function vendorPluginWithHook(name) {
  const dir = path.join(pluginDir, name);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] },
  }), 'utf8');
}

vendorPluginWithHook('reviewer');
const { reloadPlugins, buildUserPluginHooks, buildUserPluginDelivery } = await import('../llm_agent/skills/index.mjs');
// These cases are about the TRANSLATED path — llm-ide running the hooks itself.
// Native delivery (the default, where the SDK runs them) has its own file:
// plugin-native-delivery.test.mjs.
const translatedHooks = (userId) => buildUserPluginHooks(userId, { nativeEnabled: false });
const { setEnabled, setHooksTrusted } = await import('../plugins/state.mjs');
reloadPlugins();

test('no hooks for a user who has not enabled the plugin', () => {
  assert.deepEqual(translatedHooks('nobody'), {});
  assert.deepEqual(buildUserPluginDelivery('nobody').sdkPlugins, []);
});

test('enabling a plugin does not by itself arm its hooks — by either mechanism', () => {
  setEnabled('u', 'reviewer', true);
  assert.deepEqual(translatedHooks('u'), {},
    'hooks run shell commands — enabling must not be consent to that');
  assert.deepEqual(buildUserPluginDelivery('u').sdkPlugins, [],
    'nor may it be handed to the SDK, which would run those hooks itself');
});

test('an enabled + hook-trusted plugin contributes its hooks', () => {
  setEnabled('u', 'reviewer', true);
  setHooksTrusted('u', 'reviewer', true);
  const hooks = translatedHooks('u');
  assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
  // With native delivery on (the default) the same plugin goes to the SDK
  // instead, and must NOT also be translated.
  const native = buildUserPluginDelivery('u');
  assert.deepEqual(native.native, ['reviewer']);
  assert.deepEqual(native.hooks, {});
});

test('trusting hooks but disabling the plugin leaves nothing armed', () => {
  setHooksTrusted('u2', 'reviewer', true);   // trusted, never enabled
  assert.deepEqual(translatedHooks('u2'), {});
  assert.deepEqual(buildUserPluginDelivery('u2').sdkPlugins, []);
});

test('revoking trust disarms them again, under either mechanism', () => {
  setEnabled('u3', 'reviewer', true);
  setHooksTrusted('u3', 'reviewer', true);
  assert.equal(Object.keys(translatedHooks('u3')).length, 1);
  assert.deepEqual(buildUserPluginDelivery('u3').native, ['reviewer']);
  setHooksTrusted('u3', 'reviewer', false);
  assert.deepEqual(translatedHooks('u3'), {});
  assert.deepEqual(buildUserPluginDelivery('u3').sdkPlugins, [],
    'a revoked plugin stops being handed over too');
});

// --- What the composed turn actually carries ---

const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { setUserPrefs } = await import('../kb/user.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { buildReadableRoots } = await import('../llm_agent/runtime/handlers/repo-files.mjs');

const WS = path.join(__dirname, '_agent-v2-hooks-ws');
fs.mkdirSync(WS, { recursive: true });

// Capture the (prompt, options) the runner composed without spawning the SDK.
function makeFakeQuery(capture) {
  return (prompt, options) => {
    capture.options = options;
    return (async function* () { /* no messages */ })();
  };
}

const turnDeps = { readSkill: () => null, roots: () => [WS], buildReadableRoots };

async function composeTurn(userId) {
  const capture = {};
  await runAgentV2Turn({
    message: 'hi', userId, mode: 'execute',
    agentContext: { workspaceRoot: WS },
    allowAmbientAuth: true, onEvent: () => {},
    queryFactory: makeFakeQuery(capture),
  }, turnDeps);
  return capture.options;
}

test('a trusted plugin reaches the SDK as a local plugin, MCP discovery off', async () => {
  const { id } = registerUser(getDb(), {
    email: 'native-turn@example.com', password: 'pw-12345678', displayName: 'T',
  });
  setEnabled(id, 'reviewer', true);
  setHooksTrusted(id, 'reviewer', true);
  const options = await composeTurn(id);
  assert.equal(options.plugins?.length, 1, 'the turn must carry the plugin');
  assert.equal(options.plugins[0].type, 'local');
  assert.equal(options.plugins[0].skipMcpDiscovery, true);
  assert.equal(options.hooks, undefined, 'the SDK runs its hooks, so we must not too');
});

test('turning the pref off swaps the plugin option for translated hooks', async () => {
  const { id } = registerUser(getDb(), {
    email: 'translated-turn@example.com', password: 'pw-12345678', displayName: 'T2',
  });
  setEnabled(id, 'reviewer', true);
  setHooksTrusted(id, 'reviewer', true);
  setUserPrefs(id, { nativePlugins: false });
  const options = await composeTurn(id);
  assert.equal(options.plugins, undefined, 'nothing handed to the SDK');
  assert.deepEqual(Object.keys(options.hooks || {}), ['PreToolUse']);
});

test('an untrusted plugin reaches the SDK by neither route', async () => {
  const { id } = registerUser(getDb(), {
    email: 'untrusted-turn@example.com', password: 'pw-12345678', displayName: 'T3',
  });
  setEnabled(id, 'reviewer', true);
  const options = await composeTurn(id);
  assert.equal(options.plugins, undefined);
  assert.equal(options.hooks, undefined);
});
