// extension/tests/mode-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodeAssistMode, buildPrompt } from '../llm_agent/runtime/mode-classify.mjs';

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

test('classifyCodeAssistMode accepts assist_plan', async () => {
  const result = await classifyCodeAssistMode("let's work through a plan together, ask me whatever you need", {
    _runClaude: async () => '{"mode": "assist_plan"}',
  });
  assert.deepEqual(result, { mode: 'assist_plan' });
});

// A mocked _runClaude can only prove the JSON round-trips (above) — it can't
// prove the model would actually pick the right one between plan/assist_plan
// for a given message. This asserts on the prompt text itself, so a future
// edit that weakens or drops the disambiguating language fails loudly here
// instead of silently degrading real classification.
test('buildPrompt draws an explicit line between plan (one-shot) and assist_plan (collaborative)', () => {
  const prompt = buildPrompt('anything');
  assert.match(prompt, /"plan\|assist_plan\|review\|document\|execute"/);
  assert.match(prompt, /"plan":.*ONE-SHOT/);
  assert.match(prompt, /"assist_plan":.*TOGETHER/);
  // The assist_plan bullet must tell the model not to infer it from topic
  // complexity alone — that's the actual collision risk with "plan".
  assert.match(prompt, /don't infer it just because the topic sounds complex/);
});

// The classify model: derived from the provider chain (never a hard-coded
// literal), and overridable per turn so a non-anthropic chat classifies on
// its OWN provider's fast tier instead of forcing an Anthropic call.
test('classify model: chain-derived default; opts.model overrides per turn', async () => {
  const { fastModelFor } = await import('../kb/usage.mjs');
  const { MODEL } = await import('../llm_agent/runtime/mode-classify.mjs');
  assert.equal(MODEL, process.env.LLMIDE_MODE_CLASSIFY_MODEL || process.env.LLMIDE_MODEL || fastModelFor('anthropic'));

  const seen = [];
  await classifyCodeAssistMode('review this diff', {
    _runClaude: async (p, opts) => { seen.push(opts.model); return '{"mode":"review"}'; },
    model: 'o3-mini',
  });
  assert.deepEqual(seen, ['o3-mini'], 'a per-turn model override must reach runClaude');

  await classifyCodeAssistMode('review this diff', {
    _runClaude: async (p, opts) => { seen.push(opts.model); return '{"mode":"review"}'; },
  });
  assert.equal(seen[1], MODEL, 'without an override the chain-derived default rides');
});
