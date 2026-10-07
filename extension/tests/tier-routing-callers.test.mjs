// Tier routing: the call sites that FORWARD a route (spec 2026-10-07-tier-routing).
//
// Pins (1) the /code-assist runClaude wrapper's model/provider rule — a
// routed subagent call ({ model, provider }) keeps its provider, a model-only
// call (the agent loop's GLOBAL_AGENT_MODEL) never inherits the composer's
// custom provider — and (2) planner/codegen passing routeOpts('pipeline').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const tmpDb = path.join(os.tmpdir(), `_tiercallers-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
process.env.LLMIDE_DB_PATH = tmpDb;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const db = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { syncTierRouting } = await import('../server/tier-routing.mjs');
const { agentCallModelProvider, codeAssistErrorResponse } = await import('../server/ai-routes.mjs');
const { generatePlan } = await import('../agents/planner.mjs');
const { generateCodeForTask } = await import('../agents/codegen.mjs');

test.after(() => {
  db.closeDb();
  for (const s of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmpDb + s, { force: true }); } catch { /* ok */ }
  }
});

function freshUser() {
  return registerUser(db.getDb(), {
    email: `tierc-${Math.floor(performance.now() * 1000)}-${Math.random().toString(36).slice(2, 6)}@ex.com`,
    password: 'CorrectHorseBattery',
  }).id;
}

// ── ai-routes runClaude wrapper ──────────────────────────────────────────

test('wrapper: a routed subagent call keeps its own { model, provider }', () => {
  assert.deepEqual(
    agentCallModelProvider({ model: 'glm-4.6', provider: 'custom:glm' }, 'claude-sonnet-4-5', 'anthropic'),
    { model: 'glm-4.6', provider: 'custom:glm' },
  );
});

test('wrapper: a model-only call on a custom: chat does NOT inherit the composer provider', () => {
  assert.deepEqual(
    agentCallModelProvider({ model: 'claude-haiku-4-5' }, 'glm-4.6', 'custom:glm'),
    { model: 'claude-haiku-4-5', provider: undefined },
  );
});

test('wrapper: no per-call model → the composer\'s tier model and provider', () => {
  assert.deepEqual(
    agentCallModelProvider({}, 'glm-4.6', 'custom:glm'),
    { model: 'glm-4.6', provider: 'custom:glm' },
  );
  assert.deepEqual(agentCallModelProvider(undefined, 'm', undefined), { model: 'm', provider: undefined });
});

// ── /code-assist error envelope ──────────────────────────────────────────

test('code-assist: a provider-config error is a 400 with its code; anything else stays a generic 502', () => {
  const cfg = Object.assign(new Error('Custom provider custom:x not found. Register it in Settings → Model Providers.'),
    { code: 'PROVIDER_UNAVAILABLE' });
  assert.deepEqual(codeAssistErrorResponse(cfg), {
    status: 400, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: cfg.message } },
  });
  const other = codeAssistErrorResponse(new Error('/Users/x/secret path blew up'));
  assert.equal(other.status, 502);
  assert.equal(other.body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(other.body.error.message, /secret/);
});

// ── planner / codegen pass routeOpts('pipeline') ─────────────────────────

function capture(reply) {
  const calls = [];
  const fn = async (_p, opts) => { calls.push({ model: opts?.model, provider: opts?.provider }); return reply; };
  fn.calls = calls;
  return fn;
}

const PLAN_JSON = JSON.stringify({
  title: 'P', goal: 'g',
  tasks: [{ title: 'Do it', description: 'd', milestone: 'M1', estimateDays: 1, dependsOn: [] }],
});
const CODE_JSON = JSON.stringify({ summary: 's', files: [] });

function seed(userId) {
  db.ingestMeeting(userId, { id: `m-${userId}`, title: 'Standup', transcript: 'A: ship it', language: 'en' });
  const plan = db.savePlan(userId, { title: 'P', goal: 'g', meetingId: `m-${userId}`, tasks: [{ title: 'Do it' }] });
  return { meetingId: `m-${userId}`, taskId: plan.tasks[0].id };
}

test('planner + codegen: pipeline routed → { model, provider } of the tier', async () => {
  const userId = freshUser();
  syncTierRouting({
    tiers: { standard: { provider: 'openai', model: 'gpt-5' } }, features: { pipeline: 'standard' },
  }, userId);
  setSecret(db.getDb(), userId, 'openai.apiKey', 'sk-oa');
  const { meetingId, taskId } = seed(userId);

  const plan = capture(PLAN_JSON);
  await generatePlan(userId, { meetingId, goal: 'g', language: 'en', _runClaude: plan });
  assert.deepEqual(plan.calls[0], { model: 'gpt-5', provider: 'openai' });

  const code = capture(CODE_JSON);
  await generateCodeForTask(userId, { taskId, language: 'en', includeFileContext: false, _runClaude: code }).catch(() => {});
  assert.ok(code.calls.length >= 1);
  for (const c of code.calls) assert.deepEqual(c, { model: 'gpt-5', provider: 'openai' });
});

test('planner + codegen: pipeline unrouted → no model/provider forced', async () => {
  const userId = freshUser();
  const { meetingId, taskId } = seed(userId);
  const plan = capture(PLAN_JSON);
  await generatePlan(userId, { meetingId, goal: 'g', language: 'en', _runClaude: plan });
  assert.deepEqual(plan.calls[0], { model: undefined, provider: undefined });
  const code = capture(CODE_JSON);
  await generateCodeForTask(userId, { taskId, language: 'en', includeFileContext: false, _runClaude: code }).catch(() => {});
  for (const c of code.calls) assert.deepEqual(c, { model: undefined, provider: undefined });
});
