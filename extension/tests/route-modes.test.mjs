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

const { handleCodeAssist, enforceModeToolRestriction } = await import('../llm_agent/runtime/route.mjs');

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

test('mode: "assist_plan" appends the assist_plan persona and never returns a write pendingTool other than save-plan', async () => {
  const runClaude = async () => 'What would you like to build? Give me a short summary.';
  const out = await handleCodeAssist({
    message: "let's work through a plan together",
    history: [],
    agentContext: { sessionId: 'test-assist-plan-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
    mode: 'assist_plan',
  });
  assert.equal(out.mode, 'assist_plan');
  assert.ok(!out.pendingTool, `expected no pendingTool, got ${JSON.stringify(out.pendingTool)}`);
});

test('mode: an unrecognized client-supplied string (e.g. a typo) falls back to "execute" rather than silently resolving unrestricted', async () => {
  const runClaude = async () => 'Sure, done.';
  const out = await handleCodeAssist({
    message: 'do something',
    history: [],
    agentContext: { sessionId: 'test-badmode-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
    mode: 'assist-plan', // hyphen typo for "assist_plan"
  });
  assert.equal(out.mode, 'execute');
});

test('enforceModeToolRestriction clears a pendingTool for a restricted mode', () => {
  const out = { reply: 'hi', pendingTool: { name: 'create-issue', arguments: {} } };
  const result = enforceModeToolRestriction(out, 'plan');
  assert.equal(result.pendingTool, null);
  assert.equal(result.reply, 'hi'); // everything else passes through unchanged
});

test('enforceModeToolRestriction leaves execute mode untouched', () => {
  const out = { reply: 'hi', pendingTool: { name: 'create-issue', arguments: {} } };
  const result = enforceModeToolRestriction(out, 'execute');
  assert.deepEqual(result.pendingTool, { name: 'create-issue', arguments: {} });
});

test('enforceModeToolRestriction is a no-op when there is no pendingTool', () => {
  const out = { reply: 'hi', pendingTool: null };
  const result = enforceModeToolRestriction(out, 'review');
  assert.equal(result, out); // same reference — no unnecessary object copy
});

test('enforceModeToolRestriction lets a save-plan pendingTool survive in every plan-like mode', () => {
  for (const mode of ['plan', 'assist_plan']) {
    const out = { reply: 'hi', pendingTool: { name: 'save-plan', arguments: { title: 't', content: 'c' } } };
    const result = enforceModeToolRestriction(out, mode);
    assert.deepEqual(result.pendingTool, { name: 'save-plan', arguments: { title: 't', content: 'c' } },
      `expected save-plan to survive for mode "${mode}"`);
  }
});

test('enforceModeToolRestriction still clears save-plan for review/document — the carve-out is plan-like modes only', () => {
  const out = { reply: 'hi', pendingTool: { name: 'save-plan', arguments: { title: 't', content: 'c' } } };
  assert.equal(enforceModeToolRestriction(out, 'review').pendingTool, null);
  assert.equal(enforceModeToolRestriction(out, 'document').pendingTool, null);
});

test('enforceModeToolRestriction still clears every other write tool in plan-like modes — the carve-out is save-plan only', () => {
  for (const mode of ['plan', 'assist_plan']) {
    const out = { reply: 'hi', pendingTool: { name: 'update-file', arguments: {} } };
    assert.equal(enforceModeToolRestriction(out, mode).pendingTool, null, `expected update-file cleared for mode "${mode}"`);
  }
});

test('mode: "review" never injects the task-list block into the prompt, even with real session tasks', async () => {
  // Seed a real task in this session BEFORE the reviewed turn, exactly like
  // a prior Execute-mode turn would have.
  const sessionTasksModule = await import('../llm_agent/runtime/handlers/session-tasks.mjs');
  sessionTasksModule.tasks.createTask('u1', 'test-stale-tasks-1', 'Fix the auth bug');
  let capturedPrompt = '';
  const runClaude = async (prompt) => { capturedPrompt = prompt; return 'Looks fine.'; };
  const out = await handleCodeAssist({
    message: 'any issues with this?',
    history: [],
    agentContext: { sessionId: 'test-stale-tasks-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
    mode: 'review',
  });
  assert.equal(out.mode, 'review');
  assert.ok(!capturedPrompt.includes('## Your current task list'), 'stale task list leaked into a restricted-mode prompt');
});

test('mode: "plan" reports continueNeeded: false and an empty tasks array, even with real pending session tasks (prevents an unbounded auto-continue loop)', async () => {
  const sessionTasksModule = await import('../llm_agent/runtime/handlers/session-tasks.mjs');
  sessionTasksModule.tasks.createTask('u1', 'test-stale-continue-1', 'Fix the auth bug');
  const runClaude = async () => 'Here is a plan.';
  const out = await handleCodeAssist({
    message: 'how should I approach this?',
    history: [],
    agentContext: { sessionId: 'test-stale-continue-1' },
    runClaude,
    kb: fakeKb(),
    userId: 'u1',
    mode: 'plan',
  });
  assert.equal(out.mode, 'plan');
  assert.equal(out.continueNeeded, false);
  assert.deepEqual(out.tasks, []);
});
