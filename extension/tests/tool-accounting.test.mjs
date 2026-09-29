import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolAccounting, normalizeToolName } from '../llm_agent/sdk/tool-accounting.mjs';

test('normalizeToolName strips the llmide MCP prefix only', () => {
  assert.equal(normalizeToolName('mcp__llmide__find-code'), 'find-code');
  assert.equal(normalizeToolName('Read'), 'Read');
  assert.equal(normalizeToolName('mcp__other__x'), 'mcp__other__x');
});

test('pairs tool_result with its tool_use_start by id, in result order', () => {
  const acc = createToolAccounting();
  acc.observe({ type: 'tool_use_start', index: 0, id: 'a', name: 'mcp__llmide__find-code' });
  acc.observe({ type: 'tool_use_start', index: 1, id: 'b', name: 'Read' });
  acc.observe({ type: 'delta', text: 'ignored' });
  acc.observe({ type: 'tool_result', toolUseId: 'b', isError: false, text: 'x'.repeat(40), truncated: false });
  acc.observe({ type: 'tool_result', toolUseId: 'a', isError: true, text: 'err', truncated: false });
  assert.deepEqual(acc.events(), [
    { tool: 'Read', resultChars: 40, truncated: false, isError: false },
    { tool: 'find-code', resultChars: 3, truncated: false, isError: true },
  ]);
});

test('a result with no known start is recorded as unknown, never dropped silently', () => {
  const acc = createToolAccounting();
  acc.observe({ type: 'tool_result', toolUseId: 'zz', text: 'abc', truncated: true });
  assert.deepEqual(acc.events(), [{ tool: 'unknown', resultChars: 3, truncated: true, isError: false }]);
});
