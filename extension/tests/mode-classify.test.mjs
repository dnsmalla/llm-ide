// extension/tests/mode-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodeAssistMode } from '../agents/mode-classify.mjs';

test('classifyCodeAssistMode returns the model-chosen mode when valid JSON comes back', async () => {
  const result = await classifyCodeAssistMode('how would you approach fixing this?', {
    _runClaude: async () => '{"mode": "plan"}',
  });
  assert.deepEqual(result, { mode: 'plan' });
});

test('classifyCodeAssistMode falls back to execute for an unrecognised mode value', async () => {
  const result = await classifyCodeAssistMode('do something', {
    _runClaude: async () => '{"mode": "something-else"}',
  });
  assert.deepEqual(result, { mode: 'execute' });
});

test('classifyCodeAssistMode falls back to execute when the response is not JSON', async () => {
  const result = await classifyCodeAssistMode('do something', {
    _runClaude: async () => 'sure, I can help with that',
  });
  assert.deepEqual(result, { mode: 'execute' });
});

test('classifyCodeAssistMode falls back to execute when the underlying call throws', async () => {
  const result = await classifyCodeAssistMode('do something', {
    _runClaude: async () => { throw new Error('network blip'); },
  });
  assert.deepEqual(result, { mode: 'execute' });
});

test('classifyCodeAssistMode accepts review and document modes too', async () => {
  const review = await classifyCodeAssistMode('any bugs in this diff?', {
    _runClaude: async () => '{"mode": "review"}',
  });
  assert.deepEqual(review, { mode: 'review' });
  const doc = await classifyCodeAssistMode('write a README for this', {
    _runClaude: async () => '{"mode": "document"}',
  });
  assert.deepEqual(doc, { mode: 'document' });
});
