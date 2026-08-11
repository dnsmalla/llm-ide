// Per-user enable state for LLM sources — mirrors plugins/state.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Point the state file at an isolated temp dir for this process.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-state-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmpRoot, 'plugins'); // defaultSourcesDir derives from this

const { listEnabled, setEnabled, pruneOrphans } =
  await import('../llm-sources/state.mjs');

test('first-time user has an empty enable set', () => {
  assert.deepEqual([...listEnabled('user-1')], []);
});

test('setEnabled toggles and persists per user', () => {
  setEnabled('user-1', 'builtin', true);
  setEnabled('user-1', 'my-repo', true);
  assert.deepEqual([...listEnabled('user-1')].sort(), ['builtin', 'my-repo']);
  setEnabled('user-1', 'my-repo', false);
  assert.deepEqual([...listEnabled('user-1')], ['builtin']);
  // Isolated per user.
  assert.deepEqual([...listEnabled('user-2')], []);
});

test('pruneOrphans drops entries for unregistered sources', () => {
  setEnabled('user-1', 'stale', true);
  pruneOrphans(new Set(['builtin'])); // only builtin still registered
  assert.deepEqual([...listEnabled('user-1')], ['builtin']);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
