import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildAnthropicCliArgs } from '../providers/providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_AVAILABLE = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } })();

test('claude -p --mcp-config can call mcp__fake__echo', { skip: !CLAUDE_AVAILABLE && 'claude CLI not available' }, () => {
  const server = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs');
  const mcpConfigJson = JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server] } } });
  const prompt = 'Call the mcp__fake__echo tool with text "pong" and reply with exactly what it returns.';
  // Drive the real arg builder (Task 4) rather than hand-rolling argv, so this
  // test exercises the exact flags production code sends to the CLI.
  const args = buildAnthropicCliArgs(prompt, { mcpConfigJson });
  const out = execFileSync('claude', args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, MCP_TIMEOUT: '30000' } });
  assert.match(out, /pong/, `expected the model to surface the echoed text; got:\n${out}`);
});
