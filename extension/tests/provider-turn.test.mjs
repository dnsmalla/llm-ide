// A tool-capable turn on a non-Anthropic model: the switch, capability checks,
// our tools behind our permission gate, metering, fallback. Fake model and fake
// fetch only; no network, no paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { freshDb, fakeFetch, jsonResponse } from './provider-test-env.mjs';

const conns = await import('../server/provider-connections.mjs');
const { runProviderTurn, ProviderTurnError } = await import('../llm_agent/adapter/provider-turn.mjs');
const { answerDecision } = await import('../llm_agent/sdk/decisions.mjs');
const { flagQuota } = await import('../kb/usage.mjs');
const { listActivity } = await import('../kb/activity.mjs');
const { _clearCooldownsForTests, pickTurnProvider } = await import('../providers/provider-fallback.mjs');
const models = await import('../providers/provider-models.mjs');

const KEY = 'sk-turn-0123456789abcdef';
const usage = (i, o) => ({ inputTokens: { total: i }, outputTokens: { total: o } });
const toolStep = (id, name, input) => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id, toolName: name }, { type: 'tool-input-delta', id, delta: JSON.stringify(input) }, { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(10, 5) },
];
const textStep = (t) => [
  { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(12, 2) },
];
function script(...steps) {
  let i = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[Math.min(i++, steps.length - 1)] }) }),
  });
  return model;
}
// a fetch for the /models list the capability check reads
const listFetch = (ids) => fakeFetch(() => jsonResponse({ data: ids.map((id) => ({ id })) }));

function setup({ tools = true, catalogId = 'groq', ids = ['llama-3.3-70b-versatile', 'brand-new-model'] } = {}) {
  const { db, users: [a, b] } = freshDb();
  models._clearModelCacheForTests();
  _clearCooldownsForTests();
  conns.connectProvider(a, { catalogId, apiKey: KEY }, db);
  if (tools) conns.updateSettings(a, { toolsEnabled: true }, db);
  return { db, a, b, fetchImpl: listFetch(ids), provider: `custom:cat-${catalogId}` };
}
async function turn(s, over = {}, steps = [textStep('hi')]) {
  const evs = [];
  const model = over.model ?? script(...steps);
  const made = [];
  const out = await runProviderTurn({
    userId: s.a, provider: s.provider, model: 'llama-3.3-70b-versatile', message: 'do it', mode: 'execute',
    agentContext: over.agentContext ?? {}, onEvent: (e) => evs.push(e), signal: over.signal,
    deps: { db: s.db, fetchImpl: s.fetchImpl, modelFor: (x) => { made.push(x); return model; } },
    ...over.args,
  });
  return { evs, out, made, model };
}
const expectErr = async (p, code, status) => {
  await assert.rejects(p, (e) => e instanceof ProviderTurnError && e.code === code && e.status === status, code);
};

test('the switch is OFF by default: 409 before any event, no model built', async () => {
  const s = setup({ tools: false });
  const evs = []; let built = 0;
  await expectErr(runProviderTurn({ userId: s.a, provider: s.provider, model: 'm', message: 'x', onEvent: (e) => evs.push(e), deps: { db: s.db, modelFor: () => { built += 1; } } }), 'PROVIDER_TOOLS_DISABLED', 409);
  assert.deepEqual([evs.length, built], [0, 0]);
});

test('not connected, no key and bad input are refused before streaming', async () => {
  const s = setup();
  const base = { userId: s.a, provider: s.provider, model: 'llama-3.3-70b-versatile', message: 'x', onEvent: () => {}, deps: { db: s.db, fetchImpl: s.fetchImpl, modelFor: () => script(textStep('x')) } };
  await expectErr(runProviderTurn({ ...base, provider: 'custom:cat-openai' }), 'PROVIDER_NOT_CONNECTED', 404);
  await expectErr(runProviderTurn({ ...base, message: '  ' }), 'VALIDATION_FAILED', 400);
  await expectErr(runProviderTurn({ ...base, model: '' }), 'VALIDATION_FAILED', 400);
  s.db.prepare('DELETE FROM user_secrets WHERE user_id=? AND secret_key=?').run(s.a, 'custom.cat-groq.apiKey');
  await expectErr(runProviderTurn(base), 'PROVIDER_NO_KEY', 400);
  // another user cannot run on A's connection
  await expectErr(runProviderTurn({ ...base, userId: s.b }), 'PROVIDER_TOOLS_DISABLED', 409);
  conns.updateSettings(s.b, { toolsEnabled: true }, s.db);
  await expectErr(runProviderTurn({ ...base, userId: s.b }), 'PROVIDER_NOT_CONNECTED', 404);
});

test('a tool mode refuses a model without tools instead of silently dropping them', async () => {
  const s = setup();
  for (const mode of ['execute', 'plan', 'assist_plan', 'review']) {
    let built = 0;
    await expectErr(runProviderTurn({ userId: s.a, provider: s.provider, model: 'brand-new-model', message: 'x', mode, onEvent: () => {}, deps: { db: s.db, fetchImpl: s.fetchImpl, modelFor: () => { built += 1; } } }), 'MODEL_LACKS_TOOLS', 400);
    assert.equal(built, 0, mode);
  }
});

test('an override marks the model tool-capable', async () => {
  const s = setup();
  conns.updateSettings(s.a, { toolOverrides: { 'cat-groq/brand-new-model': true } }, s.db);
  const { evs } = await turn(s, { args: { model: 'brand-new-model' } });
  assert.equal(evs.find((e) => e.type === 'init').model, 'brand-new-model');
});

test('ask mode on a model without tools runs without tools and says so', async () => {
  const s = setup();
  const { evs, model } = await turn(s, { args: { model: 'brand-new-model', mode: 'ask' } });
  assert.deepEqual(evs.map((e) => e.type).slice(0, 2), ['notice', 'init']);
  assert.equal(evs[0].kind, 'tools_unavailable');
  assert.deepEqual(evs[1].tools, []);
  assert.ok(!model.doStreamCalls[0].tools?.length);
});

test('ask mode mounts only read tools; execute adds the act tools', async () => {
  const s = setup();
  const ask = (await turn(s, { args: { mode: 'ask' } })).evs.find((e) => e.type === 'init').tools;
  assert.ok(ask.includes('search-kb') && ask.includes('read-file'));
  assert.ok(!ask.includes('run-bash') && !ask.includes('task-create'));
  assert.ok(!ask.includes('ask-internal') && !ask.includes('ask-subagent'), 'nested Claude loops are never mounted');
  const exec = (await turn(s, { args: { mode: 'execute' } })).evs.find((e) => e.type === 'init').tools;
  assert.ok(exec.includes('run-bash') && exec.includes('task-create'));
});

test('a tool call runs through our registry and its result goes back to the model', async () => {
  const s = setup();
  const { evs, model } = await turn(s, { args: { mode: 'execute' }, agentContext: { sessionId: 'chat-1' } },
    [toolStep('c1', 'task-create', { title: 'write tests' }), textStep('done')]);
  const r = evs.find((e) => e.type === 'tool_result');
  assert.equal(r.isError, false);
  assert.match(r.text, /write tests/);
  assert.equal(evs.at(-1).type, 'result');
  // the model was handed our tool definition in the library's format
  const t = model.doStreamCalls[0].tools.find((x) => x.name === 'task-create');
  assert.ok(t && t.inputSchema.properties.title);
  // and the second call carried the tool result
  assert.ok(JSON.stringify(model.doStreamCalls[1].prompt).includes('write tests'));
});

test('bad arguments are refused with a message the model can fix, and the handler never runs', async () => {
  const s = setup();
  const { evs } = await turn(s, { args: { mode: 'execute' } }, [toolStep('c1', 'task-create', { title: 42 }), textStep('ok')]);
  const r = evs.find((e) => e.type === 'tool_result');
  assert.equal(r.isError, true);
  assert.match(r.text, /Invalid arguments|must be a string|invalid/i);
});

test('the permission gate: a blocked command never runs; a prompt parks an approval the user answers', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptw-'));
  // blocked
  let r = (await turn(s, { args: { mode: 'execute' }, agentContext: { workspaceRoot: ws } }, [toolStep('c1', 'run-bash', { command: 'sudo rm -rf /' }), textStep('ok')])).evs;
  const blocked = r.find((e) => e.type === 'tool_result');
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /blocked/i);
  assert.ok(!r.some((e) => e.type === 'approval_request'), 'a blocked command is not even offered');

  // prompt → deny
  for (const [action, expectRan] of [['deny', false], ['allow', true]]) {
    const evs = [];
    const done = runProviderTurn({
      userId: s.a, provider: s.provider, model: 'llama-3.3-70b-versatile', message: 'run it', mode: 'execute',
      agentContext: { workspaceRoot: ws },
      onEvent: (e) => {
        evs.push(e);
        if (e.type === 'approval_request') {
          const init = evs.find((x) => x.type === 'init');
          setImmediate(() => assert.deepEqual(answerDecision({ requestId: e.requestId, sdkSessionId: init.sessionId, userId: s.a, action }), { ok: true }));
        }
      },
      deps: { db: s.db, fetchImpl: s.fetchImpl, modelFor: () => script(toolStep('c1', 'run-bash', { command: 'echo gated-ok && echo second' }), textStep('fin')) },
    });
    await done;
    const req = evs.find((e) => e.type === 'approval_request');
    assert.ok(req, 'a compound command needs approval');
    assert.deepEqual([req.kind, req.toolName], ['ToolApproval', 'run-bash']);
    const res = evs.find((e) => e.type === 'tool_result');
    assert.equal(/gated-ok/.test(res.text), expectRan, action);
    assert.equal(res.isError, !expectRan, action);
  }
});

test('another user cannot answer this user\'s approval', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptw-'));
  const evs = [];
  const done = runProviderTurn({
    userId: s.a, provider: s.provider, model: 'llama-3.3-70b-versatile', message: 'x', mode: 'execute', agentContext: { workspaceRoot: ws },
    onEvent: (e) => {
      evs.push(e);
      if (e.type === 'approval_request') {
        const init = evs.find((x) => x.type === 'init');
        setImmediate(() => {
          assert.equal(answerDecision({ requestId: e.requestId, sdkSessionId: init.sessionId, userId: s.b, action: 'allow' }).reason, 'tenancy');
          answerDecision({ requestId: e.requestId, sdkSessionId: init.sessionId, userId: s.a, action: 'deny' });
        });
      }
    },
    deps: { db: s.db, fetchImpl: s.fetchImpl, modelFor: () => script(toolStep('c1', 'run-bash', { command: 'echo a && echo b' }), textStep('x')) },
  });
  await done;
});

test('usage is metered under the connection id', async () => {
  const s = setup();
  await turn(s, {}, [textStep('hello')]);
  const row = s.db.prepare("SELECT provider, model, endpoint, input_tokens, output_tokens FROM usage_ledger WHERE user_id=? ORDER BY id DESC LIMIT 1").get(s.a);
  assert.deepEqual(row, { provider: 'custom:cat-groq', model: 'llama-3.3-70b-versatile', endpoint: '/kb/providers/turn', input_tokens: 12, output_tokens: 2 });
});

test('fallback: a flagged provider is skipped ONCE at the start, with a notice before init; nothing switches mid-stream', async () => {
  const s = setup();
  conns.connectProvider(s.a, { catalogId: 'cerebras', apiKey: KEY }, s.db);
  conns.updateSettings(s.a, { fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-cerebras', model: 'llama-3.3-70b' }] }, s.db);
  flagQuota(s.db, s.a, s.provider, 'llama-3.3-70b-versatile');
  const f = fakeFetch((url) => jsonResponse({ data: [{ id: url.includes('cerebras') ? 'llama-3.3-70b' : 'llama-3.3-70b-versatile' }] }));
  const { evs, made, out } = await turn({ ...s, fetchImpl: f });
  assert.equal(evs[0].type, 'notice');
  assert.equal(evs[0].kind, 'provider_fallback');
  assert.deepEqual([evs[0].data.from, evs[0].data.to, evs[0].data.model], [s.provider, 'custom:cat-cerebras', 'llama-3.3-70b']);
  assert.equal(evs[1].type, 'init');
  assert.equal(evs[1].model, 'llama-3.3-70b');
  assert.equal(made.length, 1);
  assert.equal(made[0].conn.id, 'cat-cerebras');
  assert.equal(out.switched, true);
  assert.equal(listActivity(s.a).filter((x) => x.kind === 'model_fallback').length, 1);
});

test('a mid-turn 429 ends that turn with a retryable error and flags the NEXT pick; it never re-runs elsewhere', async () => {
  const s = setup();
  conns.connectProvider(s.a, { catalogId: 'cerebras', apiKey: KEY }, s.db);
  conns.updateSettings(s.a, { fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-cerebras', model: 'llama-3.3-70b' }] }, s.db);
  const bad = new MockLanguageModelV3({ doStream: async () => { throw Object.assign(new Error('Too many requests'), { statusCode: 429 }); } });
  const { evs, made } = await turn(s, { model: bad });
  const err = evs.find((e) => e.type === 'error');
  assert.deepEqual([err.code, err.retryable], ['PROVIDER_RATE_LIMITED', true]);
  assert.equal(made.length, 1, 'one model was built for the turn: no silent second provider');
  assert.ok(!evs.some((e) => e.type === 'result'));
  assert.equal(pickTurnProvider(s.a, { provider: s.provider, model: 'llama-3.3-70b-versatile', db: s.db }).provider, 'custom:cat-cerebras');
});

test('a quota 429 flags the model for the window', async () => {
  const s = setup();
  const bad = new MockLanguageModelV3({ doStream: async () => { throw Object.assign(new Error('You exceeded your current quota, please check your plan and billing details'), { statusCode: 429 }); } });
  await turn(s, { model: bad });
  const row = s.db.prepare('SELECT exhausted FROM quota_state WHERE user_id=? AND provider=?').get(s.a, s.provider);
  assert.equal(row.exhausted, 1);
});

test('no key material in any event or thrown error, even when the provider echoes it', async () => {
  const s = setup();
  const bad = new MockLanguageModelV3({ doStream: async () => { throw Object.assign(new Error(`Incorrect API key provided: ${KEY}`), { statusCode: 401 }); } });
  const { evs } = await turn(s, { model: bad });
  assert.ok(!JSON.stringify(evs).includes(KEY));
  assert.equal(evs.find((e) => e.type === 'error').code, 'PROVIDER_AUTH');
});

test('a cancelled turn emits nothing further and unparks its approvals', async () => {
  const s = setup();
  const ac = new AbortController();
  ac.abort();
  const { evs } = await turn(s, { signal: ac.signal });
  assert.deepEqual(evs, []);
});
