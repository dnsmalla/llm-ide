// The catalog's own per-user switch overlay (llm_agent/extensions/store.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-store-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(root, 'plugins');
const store = await import('../llm_agent/extensions/store.mjs');

const P = 'plugin:local/alpha';

test('an item and its members can be switched off per user, and are isolated between users', () => {
  assert.equal(store.setItemEnabled('u1', P, false), true);
  assert.equal(store.setMembersEnabled('u1', P, ['skill:sk-one', 'command:cmd-a'], false), true);
  const a = store.readOverlay('u1');
  assert.equal(a.corrupt, false);
  assert.equal(a.items.get(P).enabled, false);
  assert.deepEqual([...a.items.get(P).disabledMembers].sort(), ['command:cmd-a', 'skill:sk-one']);
  assert.equal(store.readOverlay('u2').items.size, 0, 'another user is untouched');
  // re-check one member, keep the rest
  store.setMembersEnabled('u1', P, ['skill:sk-one'], true);
  assert.deepEqual([...store.readOverlay('u1').items.get(P).disabledMembers], ['command:cmd-a']);
});

test('writers merge: toggling a member never erases the item switch, and empty entries disappear', () => {
  store.setItemEnabled('m', P, false);
  store.setMembersEnabled('m', P, ['skill:x'], false);
  assert.equal(store.readOverlay('m').items.get(P).enabled, false);
  store.setMembersEnabled('m', P, ['skill:x'], true);
  assert.equal(store.readOverlay('m').items.get(P).enabled, false);
  store.setItemEnabled('m', P, true);
  const raw = JSON.parse(fs.readFileSync(store.storeFilePath(), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.users.m.items[P].enabled, true);
  assert.equal(fs.statSync(store.storeFilePath()).mode & 0o777, 0o600);
});

test('invalid ids and members are refused, prototype keys are inert', () => {
  assert.equal(store.setItemEnabled('u', 'not-an-id', false), false);
  assert.equal(store.setMembersEnabled('u', P, ['nonsense'], false), true);
  assert.equal(store.readOverlay('u').items.size, 0, 'nothing valid was recorded');
  for (const bad of ['__proto__', 'constructor', 'prototype', '', null]) {
    assert.equal(store.setItemEnabled(bad, P, false), false, String(bad));
    assert.equal(store.readOverlay(bad).items.size, 0);
  }
  assert.equal({}.polluted, undefined);
});

test("an unrecognised entry in a user's overlay fails closed; the good entries are still read", () => {
  fs.writeFileSync(store.storeFilePath(), JSON.stringify({ version: 1, users: {
    w: { items: { [P]: { enabled: false }, 'junk': { enabled: false }, 'plugin:local/b': 'str', 'plugin:local/c': { disabledMembers: 'nope' } } },
    __proto__: { items: {} },
  } }));
  const o = store.readOverlay('w');
  assert.equal(o.corrupt, true, 'a partly unreadable overlay must not be treated as "nothing switched off"');
  assert.equal(store.readOverlay('someone-else').corrupt, false, 'another user is not affected');
  assert.equal(o.items.get(P).enabled, false);
  assert.equal(o.items.has('junk'), false);
  assert.equal(o.items.get('plugin:local/c').disabledMembers.size, 0);
});

test('an unreadable file is reported corrupt, and is never overwritten by a writer', () => {
  for (const content of ['{ nope', '[]', '{"version":1}', '{"users":[]}', 'null']) {
    fs.writeFileSync(store.storeFilePath(), content);
    assert.equal(store.readOverlay('u1').corrupt, true, content);
    assert.equal(store.setItemEnabled('u1', P, false), false, content);
    assert.equal(fs.readFileSync(store.storeFilePath(), 'utf8'), content, 'the operator keeps what was there');
  }
});

test('forgetUser removes one user and only that user', () => {
  fs.rmSync(store.storeFilePath(), { force: true });
  store.setItemEnabled('a', P, false);
  store.setItemEnabled('b', P, false);
  assert.equal(store.forgetUser('a'), true);
  assert.equal(store.readOverlay('a').items.size, 0);
  assert.equal(store.readOverlay('b').items.size, 1);
  assert.equal(store.forgetUser('nobody'), false);
});

test('each shape of partial corruption in one user entry is reported corrupt', () => {
  const bad = [
    { items: [] }, 'str', { items: { [P]: { enabled: 'yes' } } }, { items: { [P]: { disabledMembers: ['command:ok', 'nonsense'] } } },
    { items: { [P]: [] } }, { items: { 'not-an-id': { enabled: false } } },
  ];
  for (const user of bad) {
    fs.writeFileSync(store.storeFilePath(), JSON.stringify({ version: 1, users: { w: user } }));
    assert.equal(store.readOverlay('w').corrupt, true, JSON.stringify(user));
  }
  fs.writeFileSync(store.storeFilePath(), JSON.stringify({ version: 1, users: { w: { items: { [P]: { enabled: false, disabledMembers: ['command:ok'] } } } } }));
  assert.equal(store.readOverlay('w').corrupt, false, 'a clean entry is fine');
});
