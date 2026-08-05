// /code-assist must NOT silently fall back to the Anthropic agent path when a
// non-Anthropic provider is selected but no model id is supplied. Before the
// guard in route.mjs, that case dropped into runAgentLoop (because the native
// branch requires a model) and surfaced as "claude is not logged in" — masking
// the real problem ("pick a model").
//
// This is exactly the iPhone explorer-chat failure: the phone forwards
// provider="custom" (the Mac's selected provider) with an EMPTY model when
// none is persisted to AppConfig.defaultModelId, so a GLM-via-Custom user saw
// a Claude auth error instead of "select a model". Sibling to
// agent-ask-provider.test.mjs, which covers the same root cause on the
// /kb/agent/ask path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');

const baseCtx = (overrides = {}) => ({
  message: 'hi',
  history: [],
  agentContext: { recentIssues: [], recentMeetings: [] },
  // Tripwire: the Anthropic fallback path calls runClaude. If the guard works,
  // this is never reached for the non-Anthropic-no-model cases. (A plain
  // success stub is supplied separately for the anthropic-default test.)
  runClaude: async () => { throw new Error('runClaude must not be called on the fallback path'); },
  kb: { search: () => [], listMeetings: () => ({ items: [] }) },
  userId: 'user-model-guard',
  ...overrides,
});

test('handleCodeAssist: non-Anthropic provider with no model throws a clear error (no Anthropic fallback)', async () => {
  await assert.rejects(
    () => handleCodeAssist(baseCtx({ provider: 'custom', model: undefined })),
    /No model selected for provider "custom"/,
  );
  // glm is half-wired (no adapter), but the guard fires before any of that —
  // the actionable error is the same: pick a model.
  await assert.rejects(
    () => handleCodeAssist(baseCtx({ provider: 'glm', model: '' })),
    /No model selected for provider "glm"/,
  );
});

test('handleCodeAssist: anthropic default with no model is unaffected (still reaches the agent loop)', async () => {
  // No provider + no model → resolveProvider maps to 'anthropic' → the guard
  // skips → the existing Anthropic runAgentLoop path runs unchanged. This is
  // the backward-compat guarantee for every caller that sends no provider.
  const out = await handleCodeAssist(baseCtx({
    runClaude: async () => 'ok from anthropic path',
  }));
  assert.equal(out.reply, 'ok from anthropic path');
});

test('handleCodeAssist: non-Anthropic provider WITH a model is not blocked by the guard', async () => {
  // Guard must not fire when a model IS supplied — it only catches the empty
  // case. Reaching runClaude would mean the native branch's own model/key gate
  // redirected here; we just assert the guard's error is NOT thrown.
  await assert.rejects(
    () => handleCodeAssist(baseCtx({ provider: 'custom', model: 'glm-4.6' })),
    (err) => !/No model selected/.test(err.message),
  );
});
