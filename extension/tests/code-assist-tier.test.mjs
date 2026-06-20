import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTierModel } from '../llm_agent/runtime/model-tier.mjs';

test('explicit model always wins over tier', () => {
  assert.equal(
    resolveTierModel({ model: 'claude-opus-4-8', tier: 'subagent' }, { LLMIDE_SUBAGENT_MODEL: 'cheap' }),
    'claude-opus-4-8'
  );
});

test('subagent tier routes to LLMIDE_SUBAGENT_MODEL when set', () => {
  assert.equal(
    resolveTierModel({ tier: 'subagent' }, { LLMIDE_SUBAGENT_MODEL: 'claude-haiku-4-5' }),
    'claude-haiku-4-5'
  );
});

test('subagent tier falls back to undefined when env unset', () => {
  assert.equal(resolveTierModel({ tier: 'subagent' }, {}), undefined);
});

test('absent tier yields undefined (normal model)', () => {
  assert.equal(resolveTierModel({}, { LLMIDE_SUBAGENT_MODEL: 'cheap' }), undefined);
});

test('unknown tier yields undefined', () => {
  assert.equal(resolveTierModel({ tier: 'bogus' }, { LLMIDE_SUBAGENT_MODEL: 'cheap' }), undefined);
});

test('no-arg call is safe', () => {
  assert.equal(resolveTierModel(undefined, {}), undefined);
});
