// Does a Stop actually reach everything that spends money?
//
// Three seams had to be crossed, and each was broken independently:
//
//  1. v2's in-process tools. The Agent SDK's `abortController` kills its CLI
//     SUBPROCESS; every tool mounted by sdk/tools.mjs runs in the SERVER
//     process instead, and `ask-subagent`/`ask-internal` are whole nested
//     agent loops. Their toolCtx carried no `signal` at all, so a cancelled
//     turn kept making model calls. registry.mjs's `ctx.signal ?? ...` read a
//     field production never set.
//
//  2. The legacy loop's ITERATION. `signal` was forwarded into tool ctx but
//     never consulted by the loop itself, so a Stop killed run-bash and then
//     the loop calmly started iteration N+1 (up to maxIterations: 1000 for the
//     global agent).
//
//  3. The legacy loop's MODEL CALL. It received `callSignal = callDeadline
//     ?.signal` — the per-call DEADLINE, which is null on the chat path — so
//     the turn signal reached no request at all.
//
// These tests drive the REAL production wiring for (1) (runAgentV2Turn builds
// the MCP server; it is then called over a real MCP client connection) rather
// than hand-minting a toolCtx, which is what let the gap ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_turn-abort-propagation-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { runAgentLoop, runNativeAgentLoop } = await import('../llm_agent/runtime/loop.mjs');
const { buildDispatch } = await import('../llm_agent/tools/registry.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// ─── (1) v2: the turn's signal reaches the in-process tool ctx ───────────────

const turnInjectable = (runClaude) => ({
  readSkill: () => null,
  roots: () => [],
  sessionMemory: () => [],
  persistMemory: async () => null,
  runClaude,
});

// Captures the options runAgentV2Turn composed — including the REAL mounted
// llmide MCP server, whose toolCtx is the thing under test — then ends the
// stream. Same pattern as tests/agent-v2-act-tool-e2e.test.mjs.
function capturingQuery(capture) {
  return (prompt, options) => {
    capture.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: capture.sessionId, tools: [], capabilities: [] };
      yield { type: 'result', subtype: 'success', session_id: capture.sessionId };
    })();
  };
}

async function connectMounted(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'abort-propagation', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  return client;
}

// `ask-subagent` is the honest v2 target: it runs on v2 (unlike run-bash, which
// engine.mjs disallows in both tool policies), it runs IN THIS PROCESS, and a
// delegation is a full nested loop of model calls — exactly the post-Stop spend
// this fix exists to stop. An unknown subagent name is the cheap probe: reaching
// `execute` produces "no subagent named", so the two outcomes are unambiguous.
async function callAskSubagent(userId, { abortBeforeCall }) {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-abort-test';
  const capture = { sessionId: 'sdk-abort-1' };
  const ac = new AbortController();
  let modelCalls = 0;
  try {
    await runAgentV2Turn({
      message: 'delegate something', userId, mode: 'execute',
      agentContext: { workspaceRoot: process.cwd(), sessionId: 'chat-abort-1' },
      resumeSdkSessionId: capture.sessionId,
      // Production passes ONE controller in both shapes; the engine hands
      // `abortController.signal` to buildLlmIdeServer.
      abortController: ac,
      queryFactory: capturingQuery(capture),
    }, turnInjectable(async () => { modelCalls += 1; return 'a nested answer'; }));

    if (abortBeforeCall) ac.abort();
    const client = await connectMounted(capture.options.mcpServers.llmide);
    try {
      const out = await client.callTool({ name: 'ask-subagent', arguments: { name: 'nope', question: 'q' } });
      return { parsed: JSON.parse(out.content[0].text), modelCalls };
    } finally {
      await client.close();
      await capture.options.mcpServers.llmide.instance.close();
    }
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
}

test('v2 (production wiring): an aborted turn refuses an in-process llmide tool before it starts', async () => {
  const user = registerUser(getDb(), { email: 'abort-v2-1@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const { parsed, modelCalls } = await callAskSubagent(user.id, { abortBeforeCall: true });
  assert.match(parsed.error, /Cancelled/i, `expected a cancellation refusal, got ${JSON.stringify(parsed)}`);
  assert.equal(modelCalls, 0, 'a cancelled turn must not delegate (every delegation is model spend)');
});

test('v2 (production wiring): a live turn still runs the same tool — the refusal is signal-driven, not blanket', async () => {
  const user = registerUser(getDb(), { email: 'abort-v2-2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const { parsed } = await callAskSubagent(user.id, { abortBeforeCall: false });
  assert.match(parsed.error, /no subagent named/i, `execute() should have run, got ${JSON.stringify(parsed)}`);
});

// ─── the legacy dispatch table applies the same guard ────────────────────────

test('buildDispatch: an aborted turn refuses a tool the loop had already chosen', async () => {
  const ac = new AbortController();
  const dispatch = buildDispatch({ userId: 'u1', kb: null, runClaude: async () => 'nope' });
  const live = await dispatch['ask-subagent']({ name: 'nope', question: 'q' }, { signal: ac.signal });
  assert.match(live.error, /no subagent named/i, 'a live turn dispatches normally');
  ac.abort();
  const stopped = await dispatch['ask-subagent']({ name: 'nope', question: 'q' }, { signal: ac.signal });
  assert.match(stopped.error, /Cancelled/i, 'a stopped turn never enters the handler');
});

// ─── (2)+(3) the legacy fence loop ───────────────────────────────────────────

const oneReadSkill = () => new Map([[
  'peek',
  { name: 'peek', kind: 'read', schema: {}, description: 'peek at something', body: '' },
]]);

const PEEK_FENCE = '<<<TOOL_CALL>>>\n{"name":"peek","arguments":{}}\n<<<END_TOOL_CALL>>>';

test('runAgentLoop: a turn aborted during a tool call makes NO further model call', async () => {
  const ac = new AbortController();
  const prompts = [];
  const runClaude = async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? `Let me look.\n${PEEK_FENCE}` : 'I should never be asked this.';
  };
  const out = await runAgentLoop({
    skills: oneReadSkill(),
    userMessage: 'look at the thing',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    // The user presses Stop while the tool is running — the run-bash case.
    handlers: { peek: async () => { ac.abort(); return { ok: true }; } },
    signal: ac.signal,
    maxIterations: 50,
  });
  assert.equal(prompts.length, 1, `the loop must stop after the abort, not iterate again (got ${prompts.length} model calls)`);
  assert.equal(out.pendingTool, null);
  assert.equal(out.aborted, true);
  assert.match(out.reply, /stopped/, `the partial turn should come back as a normal reply, got ${JSON.stringify(out.reply)}`);
  // The shape must be a normal completion's, not a thrown AbortError: the route
  // suppresses errors on an aborted socket, so a throw discards the turn.
  assert.equal(typeof out.iterations, 'number');
  assert.equal(typeof out.cacheHits, 'number');
  assert.ok(out.reply.includes('Let me look'), 'narration produced before the Stop is kept');
});

test('runAgentLoop: with no signal a turn iterates normally', async () => {
  const prompts = [];
  const runClaude = async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1 ? `Let me look.\n${PEEK_FENCE}` : 'The thing looks fine.';
  };
  const out = await runAgentLoop({
    skills: oneReadSkill(),
    userMessage: 'look at the thing',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: { peek: async () => ({ ok: true }) },
    maxIterations: 50,
  });
  assert.equal(prompts.length, 2, 'a turn with no cancellation still folds the tool result back in');
  // Default replyMode is 'accumulated' — narration + final text.
  assert.equal(out.reply, 'Let me look.\nThe thing looks fine.');
  assert.equal(out.aborted, undefined);
});

test('runAgentLoop: the turn signal reaches the model call, and an in-flight Stop returns the partial turn', async () => {
  const ac = new AbortController();
  let sawSignal = null;
  const runClaude = async (_prompt, opts) => {
    sawSignal = opts.signal;
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(abortError()));
      ac.abort();   // the client disconnects mid-request
    });
  };
  const out = await runAgentLoop({
    skills: new Map(),
    userMessage: 'hello',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    signal: ac.signal,
  });
  assert.ok(sawSignal instanceof AbortSignal, 'the model call must receive an abort signal on the chat path (no deadline)');
  assert.equal(out.aborted, true);
  assert.match(out.reply, /stopped/);
  assert.doesNotMatch(out.reply, /deadline/, 'a user Stop is not a deadline — labelling it one invites a pointless retry');
});

test('runAgentLoop: composing with a deadline keeps the deadline working', async () => {
  const ac = new AbortController();   // never aborted
  const runClaude = async (_prompt, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(abortError()));
  });
  const out = await runAgentLoop({
    skills: new Map(),
    userMessage: 'hello',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    signal: ac.signal,
    deadlineMs: 25,
  });
  assert.match(out.reply, /deadline/, 'the per-call deadline must survive being composed with the turn signal');
  assert.equal(out.aborted, undefined);
});

// ─── the native (OpenAI-compatible) loop has the same three seams ────────────

test('runNativeAgentLoop: a turn aborted during a tool call makes NO further provider call', async () => {
  const ac = new AbortController();
  const skills = new Map([['peek', { name: 'peek', kind: 'read', schema: {}, description: 'peek', body: '' }]]);
  const calls = [];
  const complete = async ({ signal }) => {
    calls.push(signal);
    return { text: 'Let me look.', toolCalls: [{ id: 'c1', name: 'peek', arguments: {} }] };
  };
  const out = await runNativeAgentLoop({
    systemPrompt: 'sys', userMessage: 'look', skills, tools: [], complete,
    userId: 'u1', handlers: { peek: async () => { ac.abort(); return { ok: true }; } },
    kb: null, signal: ac.signal, maxIterations: 50,
  });
  assert.equal(calls.length, 1, `the native loop must stop after the abort (got ${calls.length} provider calls)`);
  assert.ok(calls[0] instanceof AbortSignal, 'the provider call must receive the turn signal');
  assert.equal(out.aborted, true);
  assert.equal(out.pendingTool, null);
  assert.match(out.reply, /stopped/);
});

test('runNativeAgentLoop: with no signal a turn iterates normally', async () => {
  const skills = new Map([['peek', { name: 'peek', kind: 'read', schema: {}, description: 'peek', body: '' }]]);
  const calls = [];
  const complete = async ({ signal }) => {
    calls.push(signal);
    return calls.length === 1
      ? { text: 'Let me look.', toolCalls: [{ id: 'c1', name: 'peek', arguments: {} }] }
      : { text: 'The thing looks fine.', toolCalls: [] };
  };
  const out = await runNativeAgentLoop({
    systemPrompt: 'sys', userMessage: 'look', skills, tools: [], complete,
    userId: 'u1', handlers: { peek: async () => ({ ok: true }) }, kb: null, maxIterations: 50,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], undefined, 'no deadline and no cancellation means no signal is invented');
  assert.equal(out.reply, 'The thing looks fine.');
  assert.equal(out.aborted, undefined);
});
