import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicCliArgs } from '../agents/providers.mjs';

test('no mcpConfigJson → today\'s argv (strict-mcp-config, no mcp flags)', () => {
  const args = buildAnthropicCliArgs('hello');
  assert.deepEqual(args, ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', 'You are a helpful AI assistant.', '-p', 'hello']);
});

test('mcpConfigJson → swap strict-mcp-config for --mcp-config + --allowedTools mcp__*', () => {
  const json = '{"mcpServers":{"slack":{"command":"npx","args":[]}}}';
  const args = buildAnthropicCliArgs('hello', { mcpConfigJson: json });
  assert.ok(args.includes('--mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], json);
  assert.ok(args.includes('--allowedTools'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__*');
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.equal(args[args.length - 1], 'hello'); // -p prompt still last
});
