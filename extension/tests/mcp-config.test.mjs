// extension/tests/mcp-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const { writeMcpRegistry, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');
const { buildMcpConfigForUser } = await import('../mcp/mcp-config.mjs');

const noRestrict = () => false;
const planMode = () => true; // restrictsTools('plan') === true

function reg(plugin) { writeMcpRegistry([plugin]); }

test('null when no plugins, none enabled, none consented, or restricted mode', () => {
  writeMcpRegistry([]);
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null);

  reg({ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'claude', builtin: false });
  // registered but not enabled/consented
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null);
  setConsented('u', 'slack', true);
  assert.equal(buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict }), null); // not enabled
  setEnabledMcp('u', 'slack', true);
  // restricted mode blocks it even when enabled+consented
  assert.equal(buildMcpConfigForUser('u', { mode: 'plan', restrictsToolsFn: planMode }), null);
});

test('returns the .mcp.json JSON for enabled+consented plugins on an unrestricted mode', () => {
  reg({ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 't' }, source: 'claude', builtin: false });
  setConsented('u', 'slack', true);
  setEnabledMcp('u', 'slack', true);
  const cfg = buildMcpConfigForUser('u', { mode: 'execute', restrictsToolsFn: noRestrict });
  assert.ok(cfg);
  const parsed = JSON.parse(cfg.mcpConfigJson);
  assert.deepEqual(parsed.mcpServers.slack, { command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 't' } });
  assert.equal(cfg.allowed, true);
});
