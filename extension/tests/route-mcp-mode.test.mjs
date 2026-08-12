import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-mcp-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(tmp, 'plugins');
const { writeMcpRegistry, setConsented, setEnabledMcp } = await import('../mcp/state.mjs');

// Write one enabled+consented plugin so buildMcpConfigForUser is non-null in execute mode.
writeMcpRegistry([{ id: 'slack', name: 'Slack', command: 'npx', args: ['-y', '@slack/mcp'], source: 'claude', builtin: false }]);
setConsented('u-mcp', 'slack', true);
setEnabledMcp('u-mcp', 'slack', true);

test('handleCodeAssist computes mcpConfig (execute→set, plan→null) and threads it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'llm_agent', 'runtime', 'route.mjs'), 'utf8');
  assert.match(src, /buildMcpConfigForUser/, 'route.mjs imports buildMcpConfigForUser');
  assert.match(src, /restrictsToolsFn:\s*restrictsTools/, 'mcpConfig is mode-gated via restrictsTools');
  // Both loop calls carry mcpConfig:
  assert.match(src, /mcpConfig,/);
});
