import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicCliArgs } from '../agents/providers.mjs';

test('no mcpConfigJson → today\'s argv (strict-mcp-config, no mcp flags)', () => {
  const args = buildAnthropicCliArgs('hello');
  assert.deepEqual(args, ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', 'You are a helpful AI assistant.', '-p', 'hello']);
});

test('mcpConfigJson → adds --mcp-config + a per-server --allowedTools rule (keeps --strict-mcp-config)', () => {
  const json = '{"mcpServers":{"slack":{"command":"npx","args":[]}}}';
  const args = buildAnthropicCliArgs('hello', { mcpConfigJson: json });
  assert.ok(args.includes('--mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], json);
  assert.ok(args.includes('--allowedTools'));
  // A bare "mcp__*" is rejected by the CLI ("Wildcard tool name ... is not
  // supported in allow rules" — confirmed against a real `claude -p` run);
  // the rule must name each configured server's scope explicitly.
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__slack__*');
  // --strict-mcp-config stays on even with --mcp-config set, so the CLI
  // doesn't also boot the operator's own ~/.claude.json-configured servers.
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.length - 1], 'hello'); // -p prompt still last
});

test('mcpConfigJson with multiple servers → one mcp__<id>__* rule per server', () => {
  const json = '{"mcpServers":{"slack":{"command":"npx","args":[]},"linear":{"command":"npx","args":[]}}}';
  const args = buildAnthropicCliArgs('hello', { mcpConfigJson: json });
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__slack__*,mcp__linear__*');
});
