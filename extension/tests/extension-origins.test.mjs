import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPinnedExtensionIds, extensionOriginAllowed, EXTENSION_IDS_FILE } from '../core/extension-origins.mjs';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-extpin-'));
const quiet = () => {};

test('no data dir or no file leaves extensions unpinned', () => {
  assert.equal(loadPinnedExtensionIds(null, quiet), null);
  assert.equal(loadPinnedExtensionIds(dir(), quiet), null);
  assert.equal(extensionOriginAllowed(`chrome-extension://${OTHER}`, null), true);
});

test('a valid file pins to exactly the listed IDs', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, EXTENSION_IDS_FILE), JSON.stringify({ ids: [ID] }));
  const ids = loadPinnedExtensionIds(d, quiet);
  assert.deepEqual(ids, [ID]);
  assert.equal(extensionOriginAllowed(`chrome-extension://${ID}`, ids), true);
  assert.equal(extensionOriginAllowed(`chrome-extension://${OTHER}`, ids), false);
  assert.equal(extensionOriginAllowed(`chrome-extension://${ID}/x`, ids), false, 'no path suffix');
  assert.equal(extensionOriginAllowed(`chrome-extension://${ID}.evil`, ids), false);
  assert.equal(extensionOriginAllowed('http://localhost:3000', ids), false, 'only extension origins are decided here');
});

test('a broken file fails closed, never back to any extension', () => {
  for (const body of ['{not json', '{"ids":"x"}', `{"ids":["${ID}","UPPER"]}`]) {
    const d = dir();
    fs.writeFileSync(path.join(d, EXTENSION_IDS_FILE), body);
    const logs = [];
    const ids = loadPinnedExtensionIds(d, (m) => logs.push(m));
    assert.deepEqual(ids, [], body);
    assert.equal(logs.length, 1);
    assert.equal(extensionOriginAllowed(`chrome-extension://${ID}`, ids), false);
  }
});
