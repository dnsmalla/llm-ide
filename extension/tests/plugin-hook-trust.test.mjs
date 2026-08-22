// Per-user, per-plugin hook trust. Hooks run shell commands the plugin author
// wrote, so trust is explicit, default-off, and stored alongside — never
// instead of — the enable state that was already there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hook-trust-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const statePath = path.join(tmp, 'plugin-state.json');

const { listEnabled, setEnabled, listHooksTrusted, setHooksTrusted, pruneOrphans } =
  await import('../plugins/state.mjs');

test('hooks are untrusted until the user says otherwise', () => {
  fs.rmSync(statePath, { force: true });
  assert.deepEqual([...listHooksTrusted('u')], []);
  setEnabled('u', 'reviewer', true);
  assert.equal(listHooksTrusted('u').has('reviewer'), false,
    'enabling a plugin must never imply trusting its hooks');
});

test('trust survives an enable toggle, and enable survives a trust toggle', () => {
  fs.rmSync(statePath, { force: true });
  setEnabled('u', 'reviewer', true);
  setHooksTrusted('u', 'reviewer', true);
  assert.equal(listHooksTrusted('u').has('reviewer'), true);
  assert.equal(listEnabled('u').has('reviewer'), true);

  setEnabled('u', 'other', true);                     // rewrites the user entry
  assert.equal(listHooksTrusted('u').has('reviewer'), true, 'trust must not be clobbered');
  setHooksTrusted('u', 'other', true);
  assert.deepEqual([...listEnabled('u')].sort(), ['other', 'reviewer']);
});

test('trust is per user and revocable', () => {
  fs.rmSync(statePath, { force: true });
  setHooksTrusted('u', 'reviewer', true);
  assert.equal(listHooksTrusted('other').has('reviewer'), false);
  setHooksTrusted('u', 'reviewer', false);
  assert.equal(listHooksTrusted('u').has('reviewer'), false);
});

test('an uninstalled plugin loses its hook trust — reinstalling never resurrects it', () => {
  fs.rmSync(statePath, { force: true });
  setEnabled('u', 'reviewer', true);
  setHooksTrusted('u', 'reviewer', true);
  pruneOrphans(new Set(['other-plugin']));
  assert.equal(listHooksTrusted('u').has('reviewer'), false);
  assert.equal(listEnabled('u').has('reviewer'), false);
});

test('a pre-existing state file with only `enabled` still loads', () => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ u: { enabled: ['legacy'] } }), 'utf8');
  assert.deepEqual([...listEnabled('u')], ['legacy']);
  assert.deepEqual([...listHooksTrusted('u')], []);
});
