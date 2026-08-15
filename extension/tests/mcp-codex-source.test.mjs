// extension/tests/mcp-codex-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanCodexMcpServers } from '../mcp/codex-source.mjs';

test('scanCodexMcpServers reads mcp_servers from a config.toml fixture', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-src-')), 'config.toml');
  fs.writeFileSync(f, `
model = "gpt-5.4"

[mcp_servers.slack]
command = "npx"
args = ["-y", "@slack/mcp"]
env = { TOKEN = "x" }

[mcp_servers.linear]
command = "npx"
args = ["-y", "@linear/mcp"]
`);
  const servers = scanCodexMcpServers(f);
  assert.equal(servers.length, 2);
  const slack = servers.find((s) => s.name === 'slack');
  assert.equal(slack.command, 'npx');
  assert.deepEqual(slack.args, ['-y', '@slack/mcp']);
  assert.equal(slack.env.TOKEN, 'x');
  const linear = servers.find((s) => s.name === 'linear');
  assert.equal(linear.env, undefined);
});

test('scanCodexMcpServers returns [] when the file is missing or has no mcp_servers', () => {
  assert.deepEqual(scanCodexMcpServers('/nonexistent/config.toml'), []);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-src-')), 'config.toml');
  fs.writeFileSync(f, 'model = "gpt-5.4"\n');
  assert.deepEqual(scanCodexMcpServers(f), []);
});

test('scanCodexMcpServers against the real ~/.codex/config.toml on this machine does not throw', () => {
  // No assertion on content (this user's config may or may not have any
  // configured) — just proving the real file parses without error, the
  // same guarantee mcp-claude-source.test.mjs doesn't need since ~/.claude.json
  // is plain JSON.
  assert.doesNotThrow(() => scanCodexMcpServers());
});
