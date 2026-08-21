// Tests for extension/connectors/connector-catalog.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_CATALOG, catalogEntry } from '../connectors/connector-catalog.mjs';

test('catalog contains exactly the five shipped connectors', () => {
  assert.deepEqual(CONNECTOR_CATALOG.map((e) => e.id).sort(),
    ['box', 'gcal', 'gdrive', 'miro', 'slack']);
});

test('every entry is fully described and ids are unique', () => {
  const ids = new Set();
  for (const e of CONNECTOR_CATALOG) {
    assert.match(e.id, /^[a-z][a-z0-9-]{1,20}$/, `bad id: ${e.id}`);
    assert.ok(!ids.has(e.id), `duplicate id: ${e.id}`);
    ids.add(e.id);
    assert.equal(typeof e.name, 'string');
    assert.ok(e.name.length > 0);
    assert.equal(typeof e.description, 'string');
    assert.equal(typeof e.icon, 'string');           // SF Symbol name
    assert.ok(['google-oauth', 'slack-oauth', 'box-ccg', 'miro-oauth'].includes(e.authKind));
    assert.match(e.docsUrl, /^https:\/\//);
    assert.equal(typeof e.pipelineReady, 'boolean');
  }
});

test('box and slack are pipeline-ready; the new three are not (phase 1)', () => {
  assert.equal(catalogEntry('box').pipelineReady, true);
  assert.equal(catalogEntry('slack').pipelineReady, true);
  for (const id of ['gdrive', 'gcal', 'miro']) {
    assert.equal(catalogEntry(id).pipelineReady, false);
  }
});

test('catalogEntry returns null for unknown ids', () => {
  assert.equal(catalogEntry('nope'), null);
});
