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

test('scanClaudeMcpServers also reads project-scoped mcpServers (claude mcp add without --scope user)', () => {
  // Real installs frequently have ZERO top-level servers: `claude mcp add`
  // defaults to project scope, storing them under projects.<path>.mcpServers.
  // Scanning only the top level made the Mac's "Add from Claude Code…"
  // submenu permanently empty for such users.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: {},
    projects: {
      '/Users/x/proj-a': {
        mcpServers: {
          markdownify: { command: 'uvx', args: ['markdownify-mcp'] },
          'http-only': { type: 'http', url: 'https://example.com/mcp' },
        },
      },
      '/Users/x/proj-b': {
        mcpServers: { pandoc: { command: 'uvx', args: ['mcp-pandoc'] } },
      },
    },
  }));
  const servers = scanClaudeMcpServers(f);
  const names = servers.map((s) => s.name).sort();
  assert.deepEqual(names, ['http-only', 'markdownify', 'pandoc'],
    'both transports are found — hosted entries used to be skipped, which reported an EMPTY scan for a config whose only servers were remote');
  assert.equal(servers.find((s) => s.name === 'markdownify').command, 'uvx');
});

test('scanClaudeMcpServers reads hosted (url) servers, which used to be dropped', () => {
  // Before this, `if (typeof s.command !== 'string') continue` skipped every
  // remote server — so a user whose only configured server was e.g. context7
  // (type: http) saw "No servers found in ~/.claude.json".
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: {
      ctx: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { KEY: 'secret' } },
      streamy: { type: 'sse', url: 'https://mcp.example.com/sse' },
      broken: { type: 'http' },                    // no url — must be skipped, not thrown on
      local: { command: 'uvx', args: ['thing'] },
    },
  }));
  const servers = scanClaudeMcpServers(f);
  assert.deepEqual(servers.map((s) => s.name).sort(), ['ctx', 'local', 'streamy']);
  const ctx = servers.find((s) => s.name === 'ctx');
  assert.equal(ctx.transport, 'http');
  assert.equal(ctx.url, 'https://mcp.example.com/mcp');
  assert.equal(ctx.headers.KEY, 'secret');
  assert.equal(servers.find((s) => s.name === 'streamy').transport, 'sse');
  assert.equal(servers.find((s) => s.name === 'local').transport, 'stdio');
});

test('scanClaudeMcpServers: a top-level server wins over a same-named project-scoped one', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({
    mcpServers: { dup: { command: 'top-level-cmd' } },
    projects: { '/p': { mcpServers: { dup: { command: 'project-cmd' }, extra: { command: 'x' } } } },
  }));
  const servers = scanClaudeMcpServers(f);
  assert.equal(servers.find((s) => s.name === 'dup').command, 'top-level-cmd');
  assert.ok(servers.some((s) => s.name === 'extra'));
});

test('scanClaudeMcpServers returns [] when the file is missing or has no mcpServers', () => {
  assert.deepEqual(scanClaudeMcpServers('/nonexistent/.claude.json'), []);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-')), '.claude.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: {} }));
  assert.deepEqual(scanClaudeMcpServers(f), []);
});
