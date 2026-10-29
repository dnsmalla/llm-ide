// K1 P2 (A2/A3/A4/A7/A8): SDK retry, rate-limit, permission-denied, refusal and
// thinking-token messages become additive `notice` events / metering. Driven by
// recorded-shape fixtures; no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-notices-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { mapSdkMessage, mapNotice } = await import('../llm_agent/sdk/events.mjs');
const { adoptEnabled } = await import('../llm_agent/sdk/adopt.mjs');
const { createNoticeEffects } = await import('../llm_agent/sdk/notice-effects.mjs');
const { recordSubscriptionLimit, getSubscriptionLimit } = await import('../kb/usage.mjs');
const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');

const setEnv = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
const withEnv = (k, v, fn) => {
  const prev = process.env[k];
  setEnv(k, v);
  try { return fn(); } finally { setEnv(k, prev); }
};
const withEnvAsync = async (k, v, fn) => {
  const prev = process.env[k];
  setEnv(k, v);
  try { return await fn(); } finally { setEnv(k, prev); }
};

const RETRY = { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4200, error_status: 529, error: 'overloaded', uuid: 'u', session_id: 's' };
const LIMIT = (status) => ({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: 1790000000, utilization: 0.93 }, uuid: 'u', session_id: 's' });
const DENIED = { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'tu1', decision_reason_type: 'mode', message: 'nope', uuid: 'u', session_id: 's' };
const FALLBACK = { type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', original_model: 'claude-a', fallback_model: 'claude-b', request_id: null, retracted_message_uuids: ['x1', 'x2'], content: 'c', uuid: 'u', session_id: 's' };
const NOFALL = { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-a', request_id: null, api_refusal_category: 'cyber', content: 'c', uuid: 'u', session_id: 's' };

test('retry becomes a warning notice with attempt data', () => {
  const [ev] = mapSdkMessage(RETRY);
  assert.equal(ev.type, 'notice');
  assert.equal(ev.kind, 'retry');
  assert.equal(ev.level, 'warning');
  assert.match(ev.text, /attempt 2 of 10/);
  assert.match(ev.text, /4s/);
  assert.deepEqual(ev.data, { attempt: 2, maxRetries: 10, retryDelayMs: 4200, errorStatus: 529, noResponse: false });
  assert.equal(ev.model, undefined, 'a notice must never carry `model`: the route meters under it');
});

test('rate limit: allowed is a quiet info signal, warning/rejected are visible, unknown is never "allowed"', () => {
  assert.equal(mapSdkMessage(LIMIT('allowed'))[0].level, 'info');
  assert.equal(mapSdkMessage(LIMIT('allowed_warning'))[0].level, 'warning');
  assert.equal(mapSdkMessage(LIMIT('rejected'))[0].level, 'error');
  const [unk] = mapSdkMessage(LIMIT('brand_new_status'));
  assert.equal(unk.data.status, 'unknown');
  assert.equal(unk.level, 'warning');
  assert.equal(mapSdkMessage({ type: 'rate_limit_event' })[0].type, 'sdk', 'no info object: observation channel only');
});

test('permission denied is an info notice (audit), not a user-facing line', () => {
  const [ev] = mapSdkMessage(DENIED);
  assert.equal(ev.kind, 'permission_denied');
  assert.equal(ev.level, 'info');
  assert.deepEqual(ev.data, { toolName: 'Bash', toolUseId: 'tu1', reasonType: 'mode', subagent: false });
  assert.ok(!JSON.stringify(ev).includes('nope'), 'the model-facing message is not copied');
});

test('refusal fallback and no-fallback are visible notices', () => {
  const [fb] = mapSdkMessage(FALLBACK);
  assert.equal(fb.kind, 'model_fallback');
  assert.equal(fb.level, 'warning');
  assert.equal(fb.data.fromModel, 'claude-a');
  assert.equal(fb.data.toModel, 'claude-b');
  assert.equal(fb.data.retractedMessages, 2);
  assert.equal(fb.model, undefined);
  const [nf] = mapSdkMessage(NOFALL);
  assert.equal(nf.kind, 'refusal');
  assert.equal(nf.level, 'error');
  assert.equal(nf.data.category, 'cyber');
});

test('thinking_tokens frames are consumed (metered by the engine), not forwarded', () => {
  const m = { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 10, uuid: 'u', session_id: 's' };
  assert.deepEqual(mapSdkMessage(m), []);
  withEnv('LLMIDE_V2_ADOPT_THINKING_TOKENS', '0', () => assert.equal(mapSdkMessage(m)[0].type, 'sdk'));
  assert.equal(mapSdkMessage({ ...m, estimated_tokens_delta: 'x' })[0].type, 'sdk', 'malformed stays observable');
});

test('malformed and unknown future messages never throw and stay on the sdk channel', () => {
  for (const bad of [
    { type: 'system', subtype: 'api_retry' },
    { type: 'system', subtype: 'permission_denied' },
    { type: 'system', subtype: 'model_refusal_fallback' },
    { type: 'system', subtype: 'model_refusal_future_thing', x: 1 },
    { type: 'rate_limit_event', rate_limit_info: 'junk' },
    { type: 'brand_new_type' },
  ]) {
    const out = mapSdkMessage(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'sdk', JSON.stringify(bad));
  }
  assert.equal(mapNotice(null), null);
  assert.deepEqual(mapSdkMessage(undefined), []);
});

test('each capability has its own kill switch back to the sdk passthrough', () => {
  for (const [name, msg] of [['RETRY', RETRY], ['RATE_LIMIT', LIMIT('allowed')], ['PERMISSION_DENIED', DENIED], ['REFUSAL', FALLBACK], ['REFUSAL', NOFALL]]) {
    withEnv(`LLMIDE_V2_ADOPT_${name}`, '0', () => assert.equal(mapSdkMessage(msg)[0].type, 'sdk', name));
    assert.equal(mapSdkMessage(msg)[0].type, 'notice', `${name} on by default`);
  }
});

test('adoptEnabled: default-on and default-off semantics', () => {
  withEnv('LLMIDE_V2_ADOPT_T', undefined, () => { assert.equal(adoptEnabled('T'), true); assert.equal(adoptEnabled('T', { defaultOn: false }), false); });
  withEnv('LLMIDE_V2_ADOPT_T', '0', () => assert.equal(adoptEnabled('T'), false));
  withEnv('LLMIDE_V2_ADOPT_T', 'off', () => assert.equal(adoptEnabled('T'), false));
  withEnv('LLMIDE_V2_ADOPT_T', '1', () => assert.equal(adoptEnabled('T', { defaultOn: false }), true));
  withEnv('LLMIDE_V2_ADOPT_T', 'garbage', () => assert.equal(adoptEnabled('T', { defaultOn: false }), false));
});

test('subscription limit store: latest wins, unknown status fails closed, malformed stores nothing', () => {
  assert.equal(recordSubscriptionLimit('u-sl', null), null);
  assert.equal(getSubscriptionLimit('u-sl'), null);
  recordSubscriptionLimit('u-sl', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 5 });
  recordSubscriptionLimit('u-sl', { status: 'allowed' });   // flap back: the latest is the truth
  assert.equal(getSubscriptionLimit('u-sl').status, 'allowed');
  recordSubscriptionLimit('u-sl', { status: 'wat' });
  assert.equal(getSubscriptionLimit('u-sl').status, 'unknown', 'never read as allowed');
});

test('notice effects: audit a denial, record limits, note one fallback activity, never throw', () => {
  const calls = [];
  const fx = createNoticeEffects({
    userId: 'u1', turnId: 't1', db: {}, log: { warn: (...a) => calls.push(['warn', ...a]) },
    deps: {
      recordAudit: (_db, row) => calls.push(['audit', row]),
      recordActivity: (row) => calls.push(['activity', row]),
      recordSubscriptionLimit: (u, i) => calls.push(['limit', u, i.status]),
    },
  });
  for (const m of [DENIED, LIMIT('allowed_warning'), LIMIT('allowed_warning'), FALLBACK, FALLBACK, NOFALL, RETRY]) {
    for (const ev of mapSdkMessage(m)) fx(ev);
  }
  fx({ type: 'delta', text: 'x' });
  fx(null);
  const kinds = calls.map((c) => c[0]);
  assert.equal(kinds.filter((k) => k === 'audit').length, 2, 'denial + no-fallback refusal');
  assert.equal(kinds.filter((k) => k === 'activity').length, 1, 'a repeated identical fallback notes once');
  assert.equal(kinds.filter((k) => k === 'limit').length, 2);
  assert.equal(calls.find((c) => c[0] === 'audit')[1].outcome, 'denied');
  assert.equal(calls.filter((c) => c[0] === 'warn').length, 2, 'limit logged on change only, plus the retry');
  // A throwing dependency is swallowed.
  const bad = createNoticeEffects({ userId: 'u', turnId: 't', db: {}, deps: { recordAudit: () => { throw new Error('boom'); } } });
  assert.doesNotThrow(() => bad(mapSdkMessage(DENIED)[0]));
});

// --- through the real engine loop -----------------------------------------------

const deps = { readSkill: () => null, roots: () => [], sessionMemory: () => [], persistMemory: async () => null };
function run(messages, extra = {}) {
  const events = [];
  const queryFactory = () => (async function* () { for (const m of messages) yield m; })();
  return runAgentV2Turn({
    message: 'hi', userId: 'u-notice', mode: 'execute', agentContext: { workspaceRoot: process.cwd() },
    allowAmbientAuth: true, onEvent: (e) => events.push(e), queryFactory, ...extra,
  }, extra.deps ?? deps).then((r) => ({ ...r, events }));
}
const INIT = { type: 'system', subtype: 'init', session_id: 'sdk-n', tools: [], capabilities: [] };
const RESULT = { type: 'result', subtype: 'success', session_id: 'sdk-n' };
const TH = (d) => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: d, estimated_tokens_delta: d, uuid: 'u', session_id: 'sdk-n' });

test('engine: thinking-token deltas are summed into usageTotals and never reach the wire', async () => {
  const { usageTotals, events } = await run([INIT, TH(100), TH(40), TH(-5), TH(0), RESULT]);
  assert.equal(usageTotals.thinkingTokens, 140);
  assert.ok(!events.some((e) => e.type === 'sdk' && e.subtype === 'thinking_tokens'));
  const off = await withEnvAsync('LLMIDE_V2_ADOPT_THINKING_TOKENS', '0', () => run([INIT, TH(100), RESULT]));
  assert.equal(off.usageTotals.thinkingTokens, undefined);
});

test('engine: retry / limit / refusal mid-stream surface in order, the turn still completes, and the refused partial is not captured as memory', async () => {
  const captured = [];
  const delta = (t) => ({ type: 'stream_event', session_id: 'sdk-n', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
  const { events, result } = await run(
    [INIT, RETRY, LIMIT('allowed_warning'), delta('REFUSED PARTIAL'), FALLBACK, delta('good answer'), RESULT],
    { deps: { ...deps, persistMemory: async (o) => { captured.push(o.reply); } } },
  );
  const types = events.map((e) => e.type === 'notice' ? `notice:${e.kind}` : e.type);
  assert.deepEqual(types.filter((t) => !['usage', 'memory', 'context_usage'].includes(t)), ['init', 'notice:retry', 'notice:rate_limit', 'delta', 'notice:model_fallback', 'delta', 'result']);
  assert.equal(result.subtype, 'success');
  assert.deepEqual(captured, ['good answer']);
});

test('engine: an old-wire consumer is untouched when everything is switched off (sdk passthrough as before)', async () => {
  const env = ['RETRY', 'RATE_LIMIT', 'PERMISSION_DENIED', 'REFUSAL', 'THINKING_TOKENS'];
  const prev = env.map((n) => process.env[`LLMIDE_V2_ADOPT_${n}`]);
  env.forEach((n) => { process.env[`LLMIDE_V2_ADOPT_${n}`] = '0'; });
  try {
    const { events } = await run([INIT, RETRY, LIMIT('allowed'), DENIED, FALLBACK, TH(3), RESULT]);
    assert.ok(!events.some((e) => e.type === 'notice'));
    assert.equal(events.filter((e) => e.type === 'sdk').length, 5);
  } finally {
    env.forEach((n, i) => { if (prev[i] === undefined) delete process.env[`LLMIDE_V2_ADOPT_${n}`]; else process.env[`LLMIDE_V2_ADOPT_${n}`] = prev[i]; });
  }
});
