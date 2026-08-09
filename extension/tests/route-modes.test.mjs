// extension/tests/route-modes.test.mjs
// Focused unit tests against handleCodeAssist's mode handling. Adjust the
// mock shape if handleCodeAssist's actual signature needs more fields than
// shown here to avoid throwing for unrelated reasons — the assertions on
// out.mode/out.pendingTool are what must hold, not the exact fixture shape.
//
// The "auto" test below overrides classification via handleCodeAssist's
// `_classifyMode` test seam rather than mocking the imported
// classifyCodeAssistMode function directly: node:test's mock.method can't
// redefine an ESM named export (module namespace properties are
// non-configurable — verified empirically), and the alternative,
// mock.module(), needs --experimental-test-module-mocks, which isn't
// available on the Node 20 this repo's CI runs
// (.github/workflows/extension-ci.yml). _classifyMode mirrors the
// _runClaude seam mode-classify.mjs itself already uses for the same
// reason, and defaults to the real classifier in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');

function fakeKb() {
  return {
    getUserPrefs: () => ({ language: 'en' }),
  };
}

test('mode: "plan" appends the plan persona and never returns a write pendingTool', async () => {
  const runClaude = async () => 'Here is my plan: 1. Do X 2. Do Y';
  const out = await handleCodeAssist({
    message: 'how should I approach this refactor?',
    history: [],
    agentContext: { sessionId: 'test-plan-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
    mode: 'plan',
  });
  assert.equal(out.mode, 'plan');
  // runAgentLoop/runNativeAgentLoop always set pendingTool explicitly to
  // `null` (never omit it) on a normal no-pending-tool completion — see
  // loop.mjs's return sites — so assert falsy rather than strictly
  // `undefined`; the intent ("no write pendingTool leaked") is unchanged.
  assert.ok(!out.pendingTool, `expected no pendingTool, got ${JSON.stringify(out.pendingTool)}`);
});

test('mode: "auto" resolves via classifyCodeAssistMode and reports the resolved mode', async () => {
  const runClaude = async () => 'Looks fine, one nit: rename this variable.';
  const out = await handleCodeAssist({
    message: 'any bugs in this diff?',
    history: [],
    agentContext: { sessionId: 'test-auto-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
    mode: 'auto',
    _classifyMode: async () => ({ mode: 'review' }),
  });
  assert.equal(out.mode, 'review');
});

test('mode: undefined behaves exactly like "execute" (back-compat — no mode field sent)', async () => {
  const runClaude = async () => 'Sure, done.';
  const out = await handleCodeAssist({
    message: 'add a hello world function',
    history: [],
    agentContext: { sessionId: 'test-nomode-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
  });
  assert.equal(out.mode, 'execute');
});
