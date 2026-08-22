// Tests for extension/connectors/mcp-connector-defs.mjs — the declarative
// per-connector table. Phase 2a ships Miro only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_CONNECTOR_DEFS, MCP_CONNECTOR_IDS, mcpConnectorDef,
  pickPath, toItemArray, pickText, stripHtml, defaultMcpItemMapper,
} from '../connectors/mcp-connector-defs.mjs';

test('phase 2a ships exactly one connector: Miro', () => {
  assert.deepEqual([...MCP_CONNECTOR_IDS], ['miro']);
  assert.equal(MCP_CONNECTOR_DEFS.length, 1);
});

test('every descriptor is complete and points at an https server', () => {
  for (const d of MCP_CONNECTOR_DEFS) {
    assert.match(d.id, /^[a-z][a-z0-9-]{1,20}$/, `bad id: ${d.id}`);
    assert.equal(typeof d.name, 'string');
    assert.ok(d.name.length > 0);
    assert.match(d.serverUrl, /^https:\/\//, `${d.id} must ship an https server URL`);
    assert.equal(typeof d.scope, 'string');
    assert.equal(typeof d.byoClient, 'boolean');
    assert.equal(typeof d.clientName, 'string');
    // Vault-key names must satisfy server/vault.mjs MCP_CREDENTIAL_KEY_RE.
    for (const k of [d.byoClientIdKey, d.byoClientSecretKey]) {
      assert.match(k, /^mcp\.[a-z][a-z0-9-]{1,40}\.[a-zA-Z]{1,32}$/, `bad vault key: ${k}`);
    }
    // Phase 2b fills these; they must exist as nulls so the shape is stable.
    assert.ok('listTool' in d && 'readTool' in d && 'mapItem' in d);
  }
});

test('Miro uses dynamic client registration — no operator setup', () => {
  const miro = mcpConnectorDef('miro');
  assert.equal(miro.byoClient, false);
  assert.equal(miro.serverUrl, 'https://mcp.miro.com');
});

test('unknown ids return null', () => {
  assert.equal(mcpConnectorDef('gdrive'), null);   // phase 3
  assert.equal(mcpConnectorDef('nope'), null);
  assert.equal(mcpConnectorDef(''), null);
  assert.equal(mcpConnectorDef(undefined), null);
});

test('the server-URL override is read per call, not at import time', () => {
  // Tests start an ephemeral fixture and only then know its port, so the
  // override MUST NOT be captured when this module was first imported.
  process.env.LLMIDE_MCP_MIRO_URL = 'http://127.0.0.1:59999/mcp';
  try {
    assert.equal(mcpConnectorDef('miro').serverUrl, 'http://127.0.0.1:59999/mcp');
  } finally {
    delete process.env.LLMIDE_MCP_MIRO_URL;
  }
  assert.equal(mcpConnectorDef('miro').serverUrl, 'https://mcp.miro.com');
});

test('the override accepts https anywhere and http only on loopback', () => {
  const cases = [
    ['https://staging.example.com/mcp', 'https://staging.example.com/mcp'],
    ['http://localhost:4000/mcp',       'http://localhost:4000/mcp'],
    ['http://[::1]:4000/mcp',           'http://[::1]:4000/mcp'],
    // Rejected → fall back to the shipped URL. A typo'd or hostile env var
    // must never turn a connector into an SSRF primitive against the LAN.
    ['http://192.168.1.10/mcp',         'https://mcp.miro.com'],
    ['http://evil.example.com/mcp',     'https://mcp.miro.com'],
    ['file:///etc/passwd',              'https://mcp.miro.com'],
    ['not a url',                       'https://mcp.miro.com'],
  ];
  for (const [raw, expected] of cases) {
    process.env.LLMIDE_MCP_MIRO_URL = raw;
    try {
      assert.equal(mcpConnectorDef('miro').serverUrl, expected, `override: ${raw}`);
    } finally {
      delete process.env.LLMIDE_MCP_MIRO_URL;
    }
  }
});

// ── Phase 2b: the fetch mapping ────────────────────────────────────────────
//
// The Miro tool NAMES here are unverified against the live server (see the
// module header). These tests deliberately assert the SHAPE and the tolerance
// of the mapping, not the names — so correcting a name is a one-line fix that
// does not cascade into the test suite.

test('Miro now declares a two-level fetch and a mapper', () => {
  const miro = mcpConnectorDef('miro');
  assert.equal(typeof miro.listTool.name, 'string');
  assert.ok(miro.listTool.name.length > 0);
  assert.equal(typeof miro.readTool.name, 'string');
  assert.equal(typeof miro.readTool.parentArg, 'string',
    'the read tool must know which argument carries the parent id');
  assert.equal(typeof miro.mapItem, 'function');
  assert.equal(miro.mapItem, defaultMcpItemMapper,
    'the descriptor stays pure data: it names the shared mapper, not a closure');
  assert.ok(Array.isArray(miro.readTool.textFields) && miro.readTool.textFields.length > 0);
  // Naming the hoisted mapper inside the frozen literal must not have cost
  // the descriptor its frozen shape.
  assert.ok(Object.isFrozen(miro));
  assert.ok(Object.isFrozen(miro.listTool) && Object.isFrozen(miro.readTool));
});

test('pickPath walks dotted paths and never throws on a miss', () => {
  const o = { a: { b: { c: 1 } }, n: null };
  assert.equal(pickPath(o, 'a.b.c'), 1);
  assert.equal(pickPath(o, 'a.b.zzz'), undefined);
  assert.equal(pickPath(o, 'n.deep.deeper'), undefined);
  assert.equal(pickPath(o, 'nope.at.all'), undefined);
  assert.equal(pickPath(o, ''), o);
});

test('toItemArray survives every plausible wrong itemsPath guess', () => {
  // The happy path.
  assert.deepEqual(toItemArray({ data: [{ id: 1 }] }, 'data'), [{ id: 1 }]);
  // Guessed 'data', server said 'items' → fall back to the only array present.
  assert.deepEqual(toItemArray({ items: [{ id: 2 }] }, 'data'), [{ id: 2 }]);
  // Server returned a bare array.
  assert.deepEqual(toItemArray([{ id: 3 }], 'data'), [{ id: 3 }]);
  // Server returned a single object with no array anywhere → treat it as one item.
  assert.deepEqual(toItemArray({ id: 4 }, 'data'), [{ id: 4 }]);
  // Non-JSON prose → one text item, not a crash and not silence.
  assert.deepEqual(toItemArray('plain prose', 'data'), [{ text: 'plain prose' }]);
  // Genuinely empty.
  assert.deepEqual(toItemArray(null, 'data'), []);
  assert.deepEqual(toItemArray({ data: [] }, 'data'), []);
});

test('toItemArray skips an EMPTY array standing in front of the real one', () => {
  // Regression: tier 3 took the literally-first array-valued property, so the
  // very common `{ errors: [], ... }` / `{ warnings: [], ... }` envelope made
  // the fetch return nothing — indistinguishable from an empty board.
  assert.deepEqual(toItemArray({ errors: [], boards: [{ id: 1 }, { id: 2 }] }, 'data'),
    [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(toItemArray({ warnings: [], items: [{ id: 1 }] }, 'data'), [{ id: 1 }]);
  // An empty array is still returned when it is genuinely all there is.
  assert.deepEqual(toItemArray({ errors: [] }, 'data'), []);
  assert.deepEqual(toItemArray({ errors: [], warnings: [] }, 'data'), []);
});

test('toItemArray drops null holes so they cannot become "null" notes', () => {
  assert.deepEqual(toItemArray({ data: [{ id: 1 }, null, undefined, { id: 2 }] }, 'data'),
    [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(toItemArray([null, { id: 3 }], 'data'), [{ id: 3 }]);
  // An array of nothing but holes is empty, not a page of "null" notes.
  assert.deepEqual(toItemArray({ data: [null, null] }, 'data'), []);
  assert.deepEqual(toItemArray({ junk: [null], items: [{ id: 4 }] }, 'data'), [{ id: 4 }]);
});

test('pickText prefers the declared fields and dumps the item when all miss', () => {
  const fields = ['data.content', 'text'];
  assert.equal(pickText({ data: { content: 'hello' } }, fields), 'hello');
  assert.equal(pickText({ text: 'fallback' }, fields), 'fallback');
  assert.equal(pickText({ data: { content: '   ' }, text: 'used' }, fields), 'used',
    'a blank match is not a match');
  // Every guess missed. The note must still carry the payload — an empty note
  // is indistinguishable from "the board was empty", which is the failure mode
  // that costs hours.
  const dumped = pickText({ id: 'x', type: 'shape', weirdField: 'payload' }, fields);
  assert.match(dumped, /payload/);
  assert.doesNotMatch(dumped, /"id"/, 'known metadata keys are excluded from the dump');
});

test('stripHtml unwraps the markup Miro puts in sticky content', () => {
  assert.equal(stripHtml('<p>hello <strong>world</strong></p>'), 'hello world');
  assert.equal(stripHtml('a<br>b'), 'a\nb');
  assert.equal(stripHtml('&lt;tag&gt; &amp; &nbsp;co'), '<tag> & co');
  assert.equal(stripHtml('no markup here'), 'no markup here');
});

test('defaultMcpItemMapper produces a stable id and the manifest field set', () => {
  const def = mcpConnectorDef('miro');
  const parent = { id: 'b1', name: 'Roadmap' };
  const item = { id: 'i9', type: 'sticky_note', data: { content: '<p>ship it</p>' },
                 modifiedAt: '2026-08-01T10:00:00.000Z' };

  const a = def.mapItem({ def, parent, item, index: 0 });
  assert.equal(a.id, 'miro:b1:i9');
  assert.equal(a.body, 'ship it');
  assert.equal(a.fields.Board, 'Roadmap');
  assert.equal(a.fields.ItemType, 'sticky_note');
  assert.match(a.fields.Date, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(a.fields.Title.includes('Roadmap'));

  // Stable across calls — the id IS the dedup key, so instability means
  // every sweep re-imports the whole board.
  assert.equal(def.mapItem({ def, parent, item, index: 0 }).id, a.id);
  assert.equal(def.mapItem({ def, parent, item, index: 7 }).id, a.id,
    'the index is only a fallback for items with no id of their own');

  // Same item id on a different board is a different note.
  const b = def.mapItem({ def, parent: { id: 'b2', name: 'Other' }, item, index: 0 });
  assert.notEqual(b.id, a.id);

  // An item with no id at all still gets a deterministic, positional one.
  const c = def.mapItem({ def, parent, item: { text: 'anon' }, index: 3 });
  assert.equal(c.id, 'miro:b1:idx3');
});
