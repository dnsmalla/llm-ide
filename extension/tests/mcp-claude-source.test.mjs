// extension/tests/mcp-claude-source.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanClaudeMcpServers } from '../mcp/claude-source.mjs';

test('scanClaudeMcpServers reads mcpServers from a Claude config fixture', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: {
      slack: { command: 'npx', args: ['-y', '@slack/mcp'], env: { TOKEN: 'x' } },
      linear: { command: 'npx', args: ['-y', '@linear/mcp'] },
    },
    otherStuff: { ignore: 'me' },
  }));
  const servers = scanClaudeMcpServers(f);
  assert.equal(servers.length, 2);
  const slack = servers.find((s) => s.name === 'slack');
  assert.equal(slack.command, 'npx');
  assert.deepEqual(slack.args, ['-y', '@slack/mcp']);
  assert.equal(slack.env.TOKEN, 'x');
});

test('scanClaudeMcpServers returns [] when the file is missing or has no mcpServers', () => {
  assert.deepEqual(scanClaudeMcpServers('/nonexistent/.claude.json'), []);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: {} }));
  assert.deepEqual(scanClaudeMcpServers(f), []);
});
