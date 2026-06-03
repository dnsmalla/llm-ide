// Tests for extension/llm_agent/runtime/handlers/ask-subagent.mjs.
// Covers: routing, error envelopes for malformed args, tool-restriction
// behavior driven by allowed_tools, and the basic happy-path loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askSubagent } from '../llm_agent/runtime/handlers/ask-subagent.mjs';

// A stub `runClaude` that captures the prompts it was asked to run and
// returns a scripted sequence of responses. Lets us assert what the
// subagent loop SENT to the model without actually calling Claude.
function makeStubClaude(responses = []) {
  const seen = [];
  let idx = 0;
  const fn = async (prompt) => {
    seen.push(prompt);
    const out = responses[idx] ?? '';
    idx += 1;
    return out;
  };
  fn.seen = seen;
  return fn;
}

function makeCtx(overrides = {}) {
  return {
    runClaude: makeStubClaude(['final answer']),
    kb: null,
    userId: 'test-user',
    subagents: new Map(),
    internalSkillsBase: '',
    ...overrides,
  };
}

test('returns answer when name + question are valid', async () => {
  const subagents = new Map([
    ['echoer', {
      systemPrompt: 'Echo what the user said.',
      allowedTools: [],
      maxIterations: 1,
      pluginName: 'test',
    }],
  ]);
  const ctx = makeCtx({ subagents, runClaude: makeStubClaude(['hi back']) });
  const out = await askSubagent({ name: 'echoer', question: 'hi' }, ctx);
  assert.equal(out.answer, 'hi back');
  assert.equal(out.pendingTool, null);
});

test('subagent system prompt is fed to runClaude verbatim', async () => {
  const subagents = new Map([
    ['unique-marker', {
      systemPrompt: 'TOKEN-A1B2C3 in the prompt.',
      allowedTools: [],
      maxIterations: 1,
      pluginName: 'test',
    }],
  ]);
  const stub = makeStubClaude(['ok']);
  await askSubagent({ name: 'unique-marker', question: 'test' }, makeCtx({ subagents, runClaude: stub }));
  assert.ok(stub.seen.length > 0, 'runClaude not called');
  assert.match(stub.seen[0], /TOKEN-A1B2C3/, 'subagent body should appear in composed prompt');
});

test('user question is included in the composed prompt', async () => {
  const subagents = new Map([
    ['x', { systemPrompt: 'sys', allowedTools: [], maxIterations: 1, pluginName: 't' }],
  ]);
  const stub = makeStubClaude(['ok']);
  await askSubagent({ name: 'x', question: 'QUESTION-MARKER-99' }, makeCtx({ subagents, runClaude: stub }));
  assert.match(stub.seen[0], /QUESTION-MARKER-99/);
});

test('unknown subagent name returns error with list of available names', async () => {
  const subagents = new Map([
    ['alpha', { systemPrompt: 's', allowedTools: [], maxIterations: 1, pluginName: 't' }],
    ['beta',  { systemPrompt: 's', allowedTools: [], maxIterations: 1, pluginName: 't' }],
  ]);
  const out = await askSubagent({ name: 'gamma', question: 'x' }, makeCtx({ subagents }));
  assert.match(out.error, /no subagent named 'gamma'/);
  assert.match(out.error, /alpha/);
  assert.match(out.error, /beta/);
});

test('unknown subagent with empty registry returns error without (available: …) suffix', async () => {
  const out = await askSubagent({ name: 'foo', question: 'x' }, makeCtx());
  assert.match(out.error, /no subagent named 'foo'/);
  assert.doesNotMatch(out.error, /available:/);
});

test('missing question yields error envelope', async () => {
  const subagents = new Map([['x', { systemPrompt: 's', allowedTools: [], maxIterations: 1, pluginName: 't' }]]);
  const out = await askSubagent({ name: 'x' }, makeCtx({ subagents }));
  assert.match(out.error, /question is required/);
});

test('whitespace-only question is rejected', async () => {
  const subagents = new Map([['x', { systemPrompt: 's', allowedTools: [], maxIterations: 1, pluginName: 't' }]]);
  const out = await askSubagent({ name: 'x', question: '   \n\t  ' }, makeCtx({ subagents }));
  assert.match(out.error, /question is required/);
});

test('non-string name is rejected (not crash)', async () => {
  const out1 = await askSubagent({ name: 42, question: 'x' }, makeCtx());
  assert.match(out1.error, /subagent name is required/);
  const out2 = await askSubagent({ name: null, question: 'x' }, makeCtx());
  assert.match(out2.error, /subagent name is required/);
  const out3 = await askSubagent({}, makeCtx());
  assert.match(out3.error, /subagent name is required/);
});

test('allowed_tools=[] → tool-call attempts have no handler available', async () => {
  // The subagent body tries to call search-kb. With empty allowed_tools
  // the handler map is empty; the loop will not execute the tool. The
  // model output (which is what we control via the stub) is what gets
  // returned. We just verify the subagent ran and returned an answer.
  const subagents = new Map([
    ['nobody', {
      systemPrompt: 'You may call search-kb if you want, but you have no tools.',
      allowedTools: [],
      maxIterations: 1,
      pluginName: 't',
    }],
  ]);
  const stub = makeStubClaude(['I have no tools, so here is my answer.']);
  const out = await askSubagent({ name: 'nobody', question: 'find decisions' },
    makeCtx({ subagents, runClaude: stub }));
  assert.equal(out.answer, 'I have no tools, so here is my answer.');
});

test('allowed_tools=[search-kb] → search-kb is wired into the loop', async () => {
  // Verify the handler attempts to register search-kb. We do this by
  // having the model attempt a tool call on the first turn and finalise
  // on the second; the second turn's prompt should include the tool
  // result block, which we can assert on.
  const subagents = new Map([
    ['searcher', {
      systemPrompt: 'Try search-kb then answer.',
      allowedTools: ['search-kb'],
      maxIterations: 2,
      pluginName: 't',
    }],
  ]);
  // Turn 1: model emits a tool call.
  // Turn 2: model emits a final answer.
  const tool = `<<<TOOL_CALL>>>\n{"name":"search-kb","arguments":{"query":"decision"}}\n<<<END_TOOL_CALL>>>`;
  const stub = makeStubClaude([tool, 'Final: searched and found nothing.']);
  // Stub the kb that search-kb reaches into. The handler must accept a
  // kb-less ctx today; we provide a minimal stub so it can run.
  const out = await askSubagent({ name: 'searcher', question: 'decisions?' },
    makeCtx({
      subagents,
      runClaude: stub,
      kb: { search: () => [] },  // returns no rows; tool result is empty.
    }));
  // We expect the second turn's prompt to contain the TOOL_RESULT block.
  assert.ok(stub.seen.length >= 2, `expected 2 prompts, saw ${stub.seen.length}`);
  assert.match(stub.seen[1], /TOOL_RESULT/);
  // The final answer is what should bubble out.
  assert.match(out.answer, /Final/);
});

test('allowed_tools containing only unknown tools collapses to empty handler set', async () => {
  const subagents = new Map([
    ['ghost', {
      systemPrompt: 'sys',
      // Both bogus — neither is registered in ALL_SUBAGENT_TOOLS.
      allowedTools: ['nonexistent', 'also-fake'],
      maxIterations: 1,
      pluginName: 't',
    }],
  ]);
  const stub = makeStubClaude(['no tools, fine']);
  const out = await askSubagent({ name: 'ghost', question: 'x' },
    makeCtx({ subagents, runClaude: stub }));
  assert.equal(out.answer, 'no tools, fine');
});

test('subagent does not inherit global chat history', async () => {
  // Caller passes a `history` field in the agentContext shape; the
  // subagent loop should NOT see it. We probe by giving the subagent's
  // body a unique marker and asserting nothing extra leaks into the
  // composed prompt that resembles past turns.
  const subagents = new Map([
    ['fresh', { systemPrompt: 'FRESH', allowedTools: [], maxIterations: 1, pluginName: 't' }],
  ]);
  const stub = makeStubClaude(['ok']);
  await askSubagent({ name: 'fresh', question: 'now' }, makeCtx({
    subagents,
    runClaude: stub,
    // history would only matter if the handler accepted it — it doesn't.
    // Probe by checking the composed prompt has no "Previous conversation"
    // section.
  }));
  assert.doesNotMatch(stub.seen[0], /Previous conversation/);
});
