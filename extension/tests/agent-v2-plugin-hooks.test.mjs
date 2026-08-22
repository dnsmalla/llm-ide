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
const { reloadPlugins, buildUserPluginHooks } = await import('../llm_agent/skills/index.mjs');
const { setEnabled, setHooksTrusted } = await import('../plugins/state.mjs');
reloadPlugins();

test('no hooks for a user who has not enabled the plugin', () => {
  assert.deepEqual(buildUserPluginHooks('nobody'), {});
});

test('enabling a plugin does not by itself arm its hooks', () => {
  setEnabled('u', 'reviewer', true);
  assert.deepEqual(buildUserPluginHooks('u'), {},
    'hooks run shell commands — enabling must not be consent to that');
});

test('an enabled + hook-trusted plugin contributes its hooks', () => {
  setEnabled('u', 'reviewer', true);
  setHooksTrusted('u', 'reviewer', true);
  const hooks = buildUserPluginHooks('u');
  assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
  assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
});

test('trusting hooks but disabling the plugin leaves nothing armed', () => {
  setHooksTrusted('u2', 'reviewer', true);   // trusted, never enabled
  assert.deepEqual(buildUserPluginHooks('u2'), {});
});

test('revoking trust disarms them again', () => {
  setEnabled('u3', 'reviewer', true);
  setHooksTrusted('u3', 'reviewer', true);
  assert.equal(Object.keys(buildUserPluginHooks('u3')).length, 1);
  setHooksTrusted('u3', 'reviewer', false);
  assert.deepEqual(buildUserPluginHooks('u3'), {});
});
