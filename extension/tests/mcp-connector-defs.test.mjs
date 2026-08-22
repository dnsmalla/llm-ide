// Tests for extension/connectors/mcp-connector-defs.mjs — the declarative
// per-connector table. Phase 2a ships Miro only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_CONNECTOR_DEFS, MCP_CONNECTOR_IDS, mcpConnectorDef,
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
