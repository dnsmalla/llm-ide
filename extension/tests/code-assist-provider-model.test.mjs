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
import os from 'node:os';

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


// ── Non-Anthropic routing: CLI subscription, or a loud error ───────────────
// Before this, a non-Anthropic provider with no API key fell into the `else`
// branch — the Anthropic loop with GLOBAL_AGENT_MODEL — so choosing Gemini or
// GLM was answered by Claude with nothing indicating the substitution. Now the
// provider either runs on its own logged-in CLI or says what is missing.

// providerApiKey() reads the operator env as a fallback, so a stray
// OPENAI_API_KEY/GOOGLE_API_KEY in the ambient environment would send these
// cases down the native (network) branch instead. Clear them per test.
const withoutProviderKeys = (fn) => async (t) => {
  const saved = {};
  for (const k of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'OPENAI_COMPAT_API_KEY']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  await fn(t);
};

test('handleCodeAssist: keyless openai delegates the turn to the codex CLI with the chosen model',
  withoutProviderKeys(async () => {
    const calls = [];
    const out = await handleCodeAssist(baseCtx({
      provider: 'openai',
      model: 'gpt-5-codex',
      runClaude: async (prompt, opts) => { calls.push({ prompt, opts }); return '  codex answered  '; },
    }));
    assert.equal(calls.length, 1, 'the CLI branch must delegate exactly once');
    assert.equal(calls[0].opts.provider, 'openai', 'provider must be forwarded so runClaude picks the codex CLI');
    assert.equal(calls[0].opts.model, 'gpt-5-codex', 'the chosen model must survive — never GLOBAL_AGENT_MODEL');
    assert.equal(out.reply, 'codex answered');
    assert.equal(out.pendingTool, null, 'a single-shot CLI turn cannot produce a tool card');
  }));

test('handleCodeAssist: the CLI delegate is rooted in the chat workspace, tilde expanded',
  withoutProviderKeys(async () => {
    // codex/gemini are agents in their own right: without a cwd they inherit
    // the SERVER's directory and reason about the wrong tree entirely.
    let opts;
    await handleCodeAssist(baseCtx({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      agentContext: { recentIssues: [], recentMeetings: [], workspaceRoot: '~' },
      runClaude: async (_p, o) => { opts = o; return 'ok'; },
    }));
    assert.equal(opts.cwd, os.homedir(), '"~" must be expanded — Node spawn does not expand it');
  }));

test('handleCodeAssist: keyless google delegates to the gemini CLI (was silently answered by Claude)',
  withoutProviderKeys(async () => {
    const calls = [];
    const out = await handleCodeAssist(baseCtx({
      provider: 'google',
      model: 'gemini-3.6-flash',
      runClaude: async (prompt, opts) => { calls.push(opts); return 'gemini answered'; },
    }));
    assert.deepEqual(
      { provider: calls[0]?.provider, model: calls[0]?.model },
      { provider: 'google', model: 'gemini-3.6-flash' },
    );
    assert.equal(out.reply, 'gemini answered');
  }));

test('handleCodeAssist: GLM points at Custom Providers instead of asking for a key it cannot use',
  withoutProviderKeys(async () => {
    await assert.rejects(
      () => handleCodeAssist(baseCtx({ provider: 'glm', model: 'glm-4.7' })),
      (err) => /Custom Providers/.test(err.message) && /api\.z\.ai/.test(err.message),
    );
  }));

test('handleCodeAssist: keyless DeepSeek asks for a key and says it has no CLI mode',
  withoutProviderKeys(async () => {
    await assert.rejects(
      () => handleCodeAssist(baseCtx({ provider: 'deepseek', model: 'deepseek-reasoner' })),
      (err) => /No API key configured for DeepSeek/.test(err.message) && /no CLI subscription mode/.test(err.message),
    );
  }));

test('handleCodeAssist: a bare glm-* model id with no explicit provider is not answered as Claude',
  withoutProviderKeys(async () => {
    // resolveProvider now maps glm-* to 'glm' rather than defaulting to
    // anthropic, so this fails loudly instead of returning a Claude reply.
    await assert.rejects(
      () => handleCodeAssist(baseCtx({
        model: 'glm-5.2',
        runClaude: async () => 'CLAUDE MUST NOT ANSWER A GLM REQUEST',
      })),
      (err) => /Custom Providers/.test(err.message),
    );
  }));
