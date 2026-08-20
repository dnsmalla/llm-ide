import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicCliArgs } from '../providers/providers.mjs';

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

test('a literal null mcpConfig (buildMcpConfigForUser\'s "no MCP" return value) does not throw', () => {
  const args = buildAnthropicCliArgs('hello', null);
  assert.deepEqual(args, ['--strict-mcp-config', '--setting-sources', '', '--tools', '', '--system-prompt', 'You are a helpful AI assistant.', '-p', 'hello']);
});

// The CLI path historically dropped the caller's model entirely — the model
// picker and the fast-model defaults (mode classify, memory extraction) were
// silently ignored on subscription installs. `--model` must ride the argv
// when a model is requested, and stay absent otherwise.
test('model → adds --model <name>; absent when no model requested', () => {
  const withModel = buildAnthropicCliArgs('hello', null, 'claude-haiku-4-5-20251001');
  assert.equal(withModel[withModel.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
  assert.equal(withModel[withModel.length - 1], 'hello'); // -p prompt still last

  const without = buildAnthropicCliArgs('hello', null);
  assert.ok(!without.includes('--model'));
  const emptyModel = buildAnthropicCliArgs('hello', null, '');
  assert.ok(!emptyModel.includes('--model'));
});

// The gate lives in the builder itself so every call site is safe: the Mac
// picker can hold non-Anthropic ids (Cursor/Copilot/Gemini) that used to be
// silently dropped on the CLI path — passing them through would turn those
// working subscription turns into CLI errors. Claude ids and the CLI's own
// bare aliases pass; anything else (foreign id, dash-prefixed junk) omits
// the flag, restoring the CLI-default behavior those turns always had.
test('model gate: foreign/dash-prefixed ids are omitted; claude ids and bare aliases pass', () => {
  assert.ok(!buildAnthropicCliArgs('h', null, 'gpt-4o').includes('--model'));
  assert.ok(!buildAnthropicCliArgs('h', null, 'gemini-2.0-flash').includes('--model'));
  assert.ok(!buildAnthropicCliArgs('h', null, '--verbose').includes('--model'));
  const alias = buildAnthropicCliArgs('h', null, 'haiku');
  assert.equal(alias[alias.indexOf('--model') + 1], 'haiku');
  const full = buildAnthropicCliArgs('h', null, 'claude-sonnet-4-6');
  assert.equal(full[full.indexOf('--model') + 1], 'claude-sonnet-4-6');
});

test('model composes with mcpConfigJson (both flag groups present)', () => {
  const json = '{"mcpServers":{"slack":{"command":"npx","args":[]}}}';
  const args = buildAnthropicCliArgs('hello', { mcpConfigJson: json }, 'claude-haiku-4-5-20251001');
  assert.ok(args.includes('--mcp-config'));
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5-20251001');
});
