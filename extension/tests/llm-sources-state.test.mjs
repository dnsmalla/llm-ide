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

const { listEnabled, setEnabled, pruneOrphans, migrateLegacyDefaultSources,
  itemKey, listDisabledItems, isItemEnabled, setItemsEnabled, pruneMissingItems } =
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
    'opt-out':       { enabled: [] },
  }));
  assert.equal(migrateLegacyDefaultSources(), true);
  assert.deepEqual([...listEnabled('only-defaults')], ['builtin']);
  assert.deepEqual([...listEnabled('both')], ['builtin']);
  assert.deepEqual([...listEnabled('with-repo')].sort(), ['builtin', 'my-repo']);
  assert.deepEqual([...listEnabled('untouched')], ['my-repo'], 'users without the legacy id are left alone');
  assert.deepEqual([...listEnabled('opt-out')], [],
    'an explicit empty set is an intentional opt-out and must stay empty');
  const raw = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'llm-sources-state.json'), 'utf8'));
  assert.equal(raw.__defaultsSeeded, true, 'reserved __ marker keys survive the rewrite');
  assert.equal(migrateLegacyDefaultSources(), false, 'idempotent: nothing left to migrate');
});

// ── Per-item selection ─────────────────────────────────────────────
// Stored as the UNCHECKED set, so an item nobody has touched — including one
// that only arrived with the latest update — is checked.

test('items are enabled until unchecked, and recheck restores them', () => {
  assert.equal(isItemEnabled('item-user', 'builtin', 'skill', 'excel-io'), true);
  setItemsEnabled('item-user', 'builtin', 'skill', ['excel-io', 'gurobi-params'], false);
  assert.equal(isItemEnabled('item-user', 'builtin', 'skill', 'excel-io'), false);
  assert.deepEqual([...listDisabledItems('item-user', 'builtin')].sort(),
    ['skill:excel-io', 'skill:gurobi-params']);
  setItemsEnabled('item-user', 'builtin', 'skill', ['excel-io'], true);
  assert.deepEqual([...listDisabledItems('item-user', 'builtin')], ['skill:gurobi-params']);
  assert.equal(itemKey('command', 'slides'), 'command:slides');
});

test('item selection is per user, per source, and per kind', () => {
  setItemsEnabled('item-a', 'builtin', 'command', ['slides'], false);
  assert.equal(isItemEnabled('item-b', 'builtin', 'command', 'slides'), true, 'other user untouched');
  assert.equal(isItemEnabled('item-a', 'other-src', 'command', 'slides'), true, 'other source untouched');
  assert.equal(isItemEnabled('item-a', 'builtin', 'skill', 'slides'), true, 'same name, other kind untouched');
});

test('source toggles and item selection never clobber each other', () => {
  setItemsEnabled('item-c', 'builtin', 'template', ['report'], false);
  setEnabled('item-c', 'my-repo', true);
  assert.equal(isItemEnabled('item-c', 'builtin', 'template', 'report'), false,
    'setEnabled must keep disabledItems');
  setItemsEnabled('item-c', 'my-repo', 'skill', ['x'], false);
  assert.deepEqual([...listEnabled('item-c')].sort(), ['builtin', 'my-repo'],
    'setItemsEnabled must keep the enabled set (incl. the implicit builtin)');
});

test('unchecking an item on a brand-new user keeps the builtin source on', () => {
  setItemsEnabled('fresh-user', 'builtin', 'skill', ['a'], false);
  assert.deepEqual([...listEnabled('fresh-user')], ['builtin']);
});

test('invalid kinds and unsafe names are ignored', () => {
  setItemsEnabled('item-d', 'builtin', 'hook', ['x'], false);
  setItemsEnabled('item-d', 'builtin', 'skill', ['../evil', '', 'ok-name'], false);
  assert.deepEqual([...listDisabledItems('item-d', 'builtin')], ['skill:ok-name']);
});

test('pruneMissingItems drops keys for items that no longer exist', () => {
  setItemsEnabled('item-e', 'builtin', 'skill', ['kept', 'gone'], false);
  pruneMissingItems('builtin', new Set(['skill:kept', 'skill:other']));
  assert.deepEqual([...listDisabledItems('item-e', 'builtin')], ['skill:kept']);
});

test('pruneOrphans drops a removed source\'s item selection too', () => {
  setEnabled('item-f', 'doomed', true);
  setItemsEnabled('item-f', 'doomed', 'skill', ['x'], false);
  setItemsEnabled('item-f', 'builtin', 'skill', ['y'], false);
  pruneOrphans(new Set(['builtin']));
  assert.deepEqual([...listDisabledItems('item-f', 'doomed')], []);
  assert.deepEqual([...listDisabledItems('item-f', 'builtin')], ['skill:y']);
});

test('pruneOrphans keeps unchecked items and the builtin default when the last source goes', () => {
  setEnabled('item-g', 'solo', true);
  setEnabled('item-g', 'builtin', false);
  setItemsEnabled('item-g', 'builtin', 'skill', ['z'], false);
  pruneOrphans(new Set(['builtin']));
  assert.deepEqual([...listEnabled('item-g')], ['builtin']);
  assert.deepEqual([...listDisabledItems('item-g', 'builtin')], ['skill:z']);
});

test('cleanup', () => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
