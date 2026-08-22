// The v2 (Agent SDK) engine had NO user MCP at all — the biggest gap the
// claude-format-plugins design names. These tests pin what a turn now mounts:
// the user's enabled+consented servers alongside the in-process `llmide`
// server, pre-approved by server-level tool spec, and withheld entirely in
// restricted modes (the same policy the legacy CLI path applies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-user-mcp-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-user-mcp-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { writeMcpRegistry, readMcpRegistry, setConsented, setEnabledMcp, syncPluginMcpServers } = await import('../mcp/state.mjs');
const { buildUserMcpServers } = await import('../llm_agent/sdk/engine.mjs');

const noRestrict = () => false;
const restricted = () => true;

function server(id, extra = {}) {
  return { id, name: id, command: 'npx', args: ['-y', id], source: 'manual', builtin: false, ...extra };
}

function activate(userId, id) {
  setConsented(userId, id, true);
  setEnabledMcp(userId, id, true);
}

test('an enabled+consented server is mounted and pre-approved server-wide', () => {
  writeMcpRegistry([server('linear')]);
  activate('u', 'linear');
  const { servers, allowedTools } = buildUserMcpServers('u', 'execute', { restrictsToolsFn: noRestrict });
  assert.deepEqual(Object.keys(servers), ['linear']);
  assert.deepEqual(servers.linear, { command: 'npx', args: ['-y', 'linear'] });
  // `mcp__<server>` is the SDK's server-level spec: every tool of that server
  // is allowed without enumerating names we cannot know ahead of connecting.
  assert.deepEqual(allowedTools, ['mcp__linear']);
});

// A fresh user id per case: per-user consent is persisted state, so reusing
// one id would let an earlier test's approval leak into this one.
test('an unconsented or disabled server is not mounted', () => {
  writeMcpRegistry([server('linear'), server('sentry')]);
  setEnabledMcp('half-a', 'linear', true);       // enabled, never consented
  setConsented('half-a', 'sentry', true);        // consented, not enabled
  const { servers } = buildUserMcpServers('half-a', 'execute', { restrictsToolsFn: noRestrict });
  assert.deepEqual(servers, {});
});

test('a restricted mode gets no user MCP at all — parity with the legacy path', () => {
  writeMcpRegistry([server('linear')]);
  activate('u', 'linear');
  const { servers, allowedTools } = buildUserMcpServers('u', 'plan', { restrictsToolsFn: restricted });
  assert.deepEqual(servers, {});
  assert.deepEqual(allowedTools, []);
});

test('a server cannot squat the in-process llmide name', () => {
  writeMcpRegistry([server('llmide')]);
  activate('squat-u', 'llmide');
  const { servers } = buildUserMcpServers('squat-u', 'execute', { restrictsToolsFn: noRestrict });
  assert.deepEqual(servers, {}, 'mounting it would replace llm-ide\'s own tool server');
});

test('an http server is mounted with its transport type and headers', () => {
  writeMcpRegistry([{
    id: 'hosted', name: 'hosted', transport: 'http', url: 'https://mcp.example.com/v1',
    headers: { 'X-A': 'b' }, source: 'manual', builtin: false,
  }]);
  activate('http-u', 'hosted');
  const { servers } = buildUserMcpServers('http-u', 'execute', { restrictsToolsFn: noRestrict });
  assert.deepEqual(servers.hosted, { type: 'http', url: 'https://mcp.example.com/v1', headers: { 'X-A': 'b' } });
});

test('a plugin-declared server needs its plugin enabled for this user', () => {
  writeMcpRegistry([]);
  syncPluginMcpServers([{ pluginName: 'reviewer', servers: [{ name: 'linear', transport: 'stdio', command: 'npx', args: [] }] }]);
  const id = readMcpRegistry()[0].id;
  activate('plug-u', id);
  // The plugin is not enabled for 'u' (no plugin-state entry at all), so the
  // server stays dark even though its own switches are on.
  const { servers } = buildUserMcpServers('plug-u', 'execute', { restrictsToolsFn: noRestrict });
  assert.deepEqual(servers, {});
});
