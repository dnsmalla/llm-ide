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

const { listEnabled, setEnabled, pruneOrphans, migrateLegacyDefaultSources } =
  await import('../llm-sources/state.mjs');

test('first-time user implicitly has the builtin (.skills) source enabled', () => {
  // No persisted entry yet — builtin (.skills) is genuinely on by default for
  // every user; there is no separate default-sources id any more (it's been
  // removed — .skills is the only always-on source).
  assert.deepEqual([...listEnabled('user-1')], ['builtin']);
});

test('setEnabled toggles and persists per user', () => {
  setEnabled('user-1', 'my-repo', true);
  assert.deepEqual([...listEnabled('user-1')].sort(), ['builtin', 'my-repo']);
  setEnabled('user-1', 'my-repo', false);
  assert.deepEqual([...listEnabled('user-1')].sort(), ['builtin']);
  // Isolated per user — user-2 is still brand new, so still implicit-only.
  assert.deepEqual([...listEnabled('user-2')], ['builtin']);
});

test('pruneOrphans drops entries for unregistered sources', () => {
  setEnabled('user-1', 'stale', true);
  pruneOrphans(new Set(['builtin'])); // only builtin still registered
  assert.deepEqual([...listEnabled('user-1')], ['builtin']);
});

test('migrateLegacyDefaultSources maps a pre-v44 default-sources entry onto builtin', () => {
  // State file persisted before v44: `default-sources` no longer exists as a
  // source. A user who had it on wanted skills, so it becomes builtin — not
  // an empty set (which would silently leave them with no skills at all).
  fs.writeFileSync(path.join(tmpRoot, 'llm-sources-state.json'), JSON.stringify({
    __defaultsSeeded: true,
    'only-defaults': { enabled: ['default-sources'] },
    'both':          { enabled: ['builtin', 'default-sources'] },
    'with-repo':     { enabled: ['my-repo', 'default-sources'] },
    'untouched':     { enabled: ['my-repo'] },
  }));
  assert.equal(migrateLegacyDefaultSources(), true);
  assert.deepEqual([...listEnabled('only-defaults')], ['builtin']);
  assert.deepEqual([...listEnabled('both')], ['builtin']);
  assert.deepEqual([...listEnabled('with-repo')].sort(), ['builtin', 'my-repo']);
  assert.deepEqual([...listEnabled('untouched')], ['my-repo'], 'users without the legacy id are left alone');
  assert.equal(migrateLegacyDefaultSources(), false, 'idempotent: nothing left to migrate');
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
