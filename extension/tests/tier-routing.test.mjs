// Tier routing: per-role provider + model (spec 2026-10-07-tier-routing).
//
// Pins the server half: the per-user store behind POST /kb/routing-tiers
// (normalize/validate, isolation, persistence), the resolver that turns a
// tier/feature into `{ provider, model }` or null (unset / unusable → the
// caller's default path), runClaude honouring an explicit `custom:<uuid>`
// provider, the loader's `tier:` frontmatter, and ask-subagent's precedence
// (model > tier > features.subagents > default).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const tmpDb = path.join(os.tmpdir(), `_tierrouting-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
process.env.LLMIDE_DB_PATH = tmpDb;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEEPSEEK_API_KEY;

const db = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { syncCustomProviders } = await import('../server/custom-providers.mjs');
const {
  syncTierRouting, getTierRoutingConfig, handleTierRoutingSync, _resetTierRoutingCacheForTests,
} = await import('../server/tier-routing.mjs');
const { resolveTier, resolveFeatureRoute, routeOpts } = await import('../providers/tier-routing.mjs');
const { runClaude } = await import('../providers/runtime.mjs');
const { loadPlugins } = await import('../plugins/loader.mjs');
const { askSubagent } = await import('../llm_agent/runtime/handlers/ask-subagent.mjs');

let reset = false;
function freshUser() {
  if (!reset) {
    db.closeDb();
    for (const s of ['', '-wal', '-shm']) {
      try { fs.rmSync(tmpDb + s, { force: true }); } catch { /* ok */ }
    }
    reset = true;
  }
  return registerUser(db.getDb(), {
    email: `tier-${Math.floor(performance.now() * 1000)}-${Math.random().toString(36).slice(2, 6)}@ex.com`,
    password: 'CorrectHorseBattery',
  }).id;
}

function registerCustom(userId, { id = 'glm-1', isEnabled = true, seedKey = true } = {}) {
  // The vault's custom-key namespace is lowercase (the Mac lowercases the UUID).
  const vaultKey = `custom.${id.toLowerCase()}.apiKey`;
  syncCustomProviders([{
    id, name: 'GLM', baseURL: 'https://api.example.com/v1', apiKey: vaultKey,
    models: ['glm-4.6'], isOpenAICompatible: true, isEnabled,
  }], userId);
  if (seedKey) setSecret(db.getDb(), userId, vaultKey, 'sk-glm-test');
  return `custom:${id}`;
}

// ── store: normalize / validate ──────────────────────────────────────────

test('syncTierRouting keeps valid entries and drops invalid ones', () => {
  const userId = freshUser();
  syncTierRouting({
    tiers: {
      strong: { provider: 'anthropic', model: 'claude-opus-5-5' },
      standard: { provider: 'bogus', model: 'x' },                       // bad provider
      cheap: { provider: 'custom:ABC-123', model: 'glm-4.6' },
      ultra: { provider: 'anthropic', model: 'claude-opus-5-5' },        // bad tier name
    },
    features: {
      subagents: 'cheap', loop: 'standard', autoTasks: 'mega',           // bad tier ref
      quickChat: 'strong', nonsense: 'cheap',                            // bad feature name
    },
  }, userId);
  const cfg = getTierRoutingConfig(userId);
  assert.deepEqual(cfg.tiers, {
    strong: { provider: 'anthropic', model: 'claude-opus-5-5' },
    cheap: { provider: 'custom:ABC-123', model: 'glm-4.6' },
  });
  assert.deepEqual(cfg.features, { subagents: 'cheap', loop: 'standard', quickChat: 'strong' });
});

test('syncTierRouting rejects unsafe model ids and oversized custom ids', () => {
  const userId = freshUser();
  syncTierRouting({
    tiers: {
      strong: { provider: 'anthropic', model: 'claude opus; rm -rf' },
      standard: { provider: `custom:${'a'.repeat(101)}`, model: 'glm-4.6' },
      cheap: { provider: 'deepseek', model: 'deepseek-chat' },
    },
  }, userId);
  assert.deepEqual(getTierRoutingConfig(userId).tiers, { cheap: { provider: 'deepseek', model: 'deepseek-chat' } });
});

test('syncTierRouting tolerates garbage input (empty config, no throw)', () => {
  const userId = freshUser();
  syncTierRouting(null, userId);
  assert.deepEqual(getTierRoutingConfig(userId), { tiers: {}, features: {} });
  syncTierRouting({ tiers: 'x', features: [1, 2] }, userId);
  assert.deepEqual(getTierRoutingConfig(userId), { tiers: {}, features: {} });
});

test('config is per user and survives a cache reset (persisted in user_flags)', () => {
  const alice = freshUser();
  const bob = freshUser();
  syncTierRouting({ tiers: { cheap: { provider: 'anthropic', model: 'claude-haiku-4-5' } }, features: { internal: 'cheap' } }, alice);
  syncTierRouting({ tiers: { strong: { provider: 'openai', model: 'gpt-5' } } }, bob);
  _resetTierRoutingCacheForTests();
  assert.deepEqual(getTierRoutingConfig(alice).tiers, { cheap: { provider: 'anthropic', model: 'claude-haiku-4-5' } });
  assert.deepEqual(getTierRoutingConfig(alice).features, { internal: 'cheap' });
  assert.deepEqual(getTierRoutingConfig(bob).tiers, { strong: { provider: 'openai', model: 'gpt-5' } });
  assert.deepEqual(getTierRoutingConfig(bob).features, {});
});

// ── resolver ─────────────────────────────────────────────────────────────

test('resolveTier: unset tier → null; built-in provider → route', () => {
  const userId = freshUser();
  assert.equal(resolveTier(userId, 'strong'), null);
  syncTierRouting({ tiers: { strong: { provider: 'anthropic', model: 'claude-opus-5-5' } } }, userId);
  assert.deepEqual(resolveTier(userId, 'strong'), { provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.equal(resolveTier(userId, 'cheap'), null);
  assert.equal(resolveTier(userId, 'not-a-tier'), null);
  assert.equal(resolveTier(undefined, 'strong'), null);
});

test('resolveTier: custom provider usable only when registered, enabled and keyed', () => {
  const userId = freshUser();
  syncTierRouting({ tiers: { cheap: { provider: 'custom:glm-1', model: 'glm-4.6' } } }, userId);
  assert.equal(resolveTier(userId, 'cheap'), null, 'not registered → null');

  registerCustom(userId, { isEnabled: false });
  assert.equal(resolveTier(userId, 'cheap'), null, 'disabled → null');

  syncTierRouting({ tiers: { cheap: { provider: 'custom:glm-nokey', model: 'glm-4.6' } } }, userId);
  registerCustom(userId, { id: 'glm-nokey', seedKey: false });
  assert.equal(resolveTier(userId, 'cheap'), null, 'no key → null');

  syncTierRouting({ tiers: { cheap: { provider: 'custom:glm-ok', model: 'glm-4.6' } } }, userId);
  registerCustom(userId, { id: 'glm-ok' });
  assert.deepEqual(resolveTier(userId, 'cheap'), { provider: 'custom:glm-ok', model: 'glm-4.6' });
});

test('resolveTier: deepseek without a key → null, with a key → route', () => {
  const userId = freshUser();
  syncTierRouting({ tiers: { cheap: { provider: 'deepseek', model: 'deepseek-chat' } } }, userId);
  assert.equal(resolveTier(userId, 'cheap'), null);
  setSecret(db.getDb(), userId, 'deepseek.apiKey', 'sk-ds');
  assert.deepEqual(resolveTier(userId, 'cheap'), { provider: 'deepseek', model: 'deepseek-chat' });
});

test('resolveFeatureRoute + routeOpts: feature → tier → route, fallback otherwise', () => {
  const userId = freshUser();
  assert.equal(resolveFeatureRoute(userId, 'pipeline'), null);
  assert.deepEqual(routeOpts(userId, 'pipeline'), {});
  assert.deepEqual(routeOpts(userId, 'pipeline', { model: 'm-default' }), { model: 'm-default' });

  syncTierRouting({
    tiers: { standard: { provider: 'openai', model: 'gpt-5' } },
    features: { pipeline: 'standard', internal: 'cheap' },               // cheap unset
  }, userId);
  assert.deepEqual(resolveFeatureRoute(userId, 'pipeline'), { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(routeOpts(userId, 'pipeline'), { provider: 'openai', model: 'gpt-5' });
  assert.equal(resolveFeatureRoute(userId, 'internal'), null, 'feature → unset tier → null');
  assert.deepEqual(routeOpts(userId, 'internal', { model: 'm-default' }), { model: 'm-default' });
  assert.deepEqual(routeOpts(undefined, 'pipeline', { model: 'x' }), { model: 'x' });
});

// ── HTTP handler ─────────────────────────────────────────────────────────

function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}
function fakeRes() {
  const res = { status: null, body: null, headers: {} };
  res.writeHead = (s, h) => { res.status = s; Object.assign(res.headers, h || {}); return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (b) => { res.body = b ? JSON.parse(String(b)) : null; };
  return res;
}

test('POST /kb/routing-tiers stores the config and answers { success: true }', async () => {
  const userId = freshUser();
  const res = fakeRes();
  await handleTierRoutingSync(fakeReq('POST', {
    tiers: { cheap: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
    features: { subagents: 'cheap' },
  }), res, userId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true });
  assert.deepEqual(getTierRoutingConfig(userId).features, { subagents: 'cheap' });
});

test('POST /kb/routing-tiers rejects a non-object body and other methods', async () => {
  const userId = freshUser();
  const bad = fakeRes();
  await handleTierRoutingSync(fakeReq('POST', '[1,2]'), bad, userId);
  assert.equal(bad.status, 400);
  const wrong = fakeRes();
  await handleTierRoutingSync(fakeReq('GET'), wrong, userId);
  assert.equal(wrong.status, 405);
});

// ── runClaude honours an explicit custom:<uuid> provider ─────────────────

test('runClaude: explicit custom:<uuid> provider dispatches to that provider', async () => {
  const userId = freshUser();
  const pid = registerCustom(userId, { id: 'Glm-UPPER-1' });
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true, status: 200, headers: new Map(),
      json: async () => ({ choices: [{ message: { content: 'glm-reply' } }] }),
      text: async () => '{}',
    };
  };
  try {
    // `glm-4.6` is not prefix-routable: without the explicit provider being
    // honoured this would never reach the custom provider's base URL.
    const out = await runClaude('hi', { userId, model: 'glm-4.6', provider: pid });
    assert.equal(out, 'glm-reply');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /api\.example\.com\/v1\/chat\/completions/);
  } finally { globalThis.fetch = original; }
});

// ── loader: `tier:` frontmatter ──────────────────────────────────────────

test('loader parses subagent `tier:` and drops an invalid one', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tier-loader-'));
  const dir = path.join(root, 'example');
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'example', version: '0.1.0', displayName: 'E', description: 't' }));
  writeFileSync(path.join(dir, 'agents', 'cheapo.md'), '---\ndescription: c\ntier: cheap\n---\nBody.');
  writeFileSync(path.join(dir, 'agents', 'weird.md'), '---\ndescription: w\ntier: platinum\n---\nBody.');
  try {
    const { plugins } = loadPlugins({ pluginDir: root });
    const subs = plugins.get('example').subagents;
    assert.equal(subs.cheapo.tier, 'cheap');
    assert.equal(subs.weird.tier, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── ask-subagent precedence ──────────────────────────────────────────────

function captureClaude() {
  const calls = [];
  const fn = async (_prompt, opts) => { calls.push({ model: opts?.model, provider: opts?.provider }); return 'ok'; };
  fn.calls = calls;
  return fn;
}

function subCtx(sub, { tiers = {}, features = {} } = {}) {
  const runClaude = captureClaude();
  return {
    runClaude,
    ctx: {
      runClaude, kb: null, userId: 'u-1', internalSkillsBase: '',
      defaultModel: 'default-model',
      subagents: new Map([['s', { systemPrompt: 'sys', allowedTools: [], maxIterations: 1, pluginName: 't', ...sub }]]),
      resolveTier: (tier) => tiers[tier] ?? null,
      resolveFeatureRoute: (feature) => (features[feature] ? (tiers[features[feature]] ?? null) : null),
    },
  };
}

const TIERS = {
  strong: { provider: 'anthropic', model: 'claude-opus-5-5' },
  cheap: { provider: 'custom:glm', model: 'glm-4.6' },
};

test('ask-subagent: frontmatter model wins over tier and feature', async () => {
  const { runClaude, ctx } = subCtx({ model: 'claude-haiku-4-5', tier: 'strong' }, { tiers: TIERS, features: { subagents: 'cheap' } });
  await askSubagent({ name: 's', question: 'q' }, ctx);
  assert.deepEqual(runClaude.calls[0], { model: 'claude-haiku-4-5', provider: undefined });
});

test('ask-subagent: subagent tier wins over features.subagents', async () => {
  const { runClaude, ctx } = subCtx({ tier: 'strong' }, { tiers: TIERS, features: { subagents: 'cheap' } });
  await askSubagent({ name: 's', question: 'q' }, ctx);
  assert.deepEqual(runClaude.calls[0], { model: 'claude-opus-5-5', provider: 'anthropic' });
});

test('ask-subagent: unusable subagent tier falls through to features.subagents', async () => {
  const { runClaude, ctx } = subCtx({ tier: 'standard' }, { tiers: TIERS, features: { subagents: 'cheap' } });
  await askSubagent({ name: 's', question: 'q' }, ctx);
  assert.deepEqual(runClaude.calls[0], { model: 'glm-4.6', provider: 'custom:glm' });
});

test('ask-subagent: nothing routed → today\'s default model, no provider', async () => {
  const { runClaude, ctx } = subCtx({}, { tiers: TIERS });
  await askSubagent({ name: 's', question: 'q' }, ctx);
  assert.deepEqual(runClaude.calls[0], { model: 'default-model', provider: undefined });
});

test('ask-subagent: no resolvers on ctx (older callers) → default model', async () => {
  const { runClaude, ctx } = subCtx({ tier: 'cheap' });
  delete ctx.resolveTier;
  delete ctx.resolveFeatureRoute;
  await askSubagent({ name: 's', question: 'q' }, ctx);
  assert.deepEqual(runClaude.calls[0], { model: 'default-model', provider: undefined });
});

// ── internal helpers: features.internal replaces their default model ─────

const { summarizeTranscript } = await import('../agents/summarize.mjs');
const { classifyEmail } = await import('../agents/email-classify.mjs');
const { classifyConnectorItem } = await import('../agents/connector-classify.mjs');
const { draftQuestion } = await import('../agents/agent-prompt.mjs');

function capturing(reply) {
  const calls = [];
  const fn = async (_p, opts) => { calls.push({ model: opts?.model, provider: opts?.provider }); return reply; };
  fn.calls = calls;
  return fn;
}

const SUMMARY_JSON = JSON.stringify({ gist: 'g', tldr: ['a'], full: '## Summary\n', actions: [], decisions: [], blockers: [] });
const CLASSIFY_JSON = JSON.stringify({ category: 'other', noteWorthy: false, summary: '', todos: [] });
const QUESTION_JSON = JSON.stringify({ shouldAsk: false, question: '', score: 0, planTaskId: null, reason: 'r' });

async function runInternalHelpers(userId) {
  const sum = capturing(SUMMARY_JSON);
  const summary = await summarizeTranscript({ transcript: 't', title: 'T', language: 'en', userId, _runClaude: sum });
  const email = capturing(CLASSIFY_JSON);
  const emailOut = await classifyEmail({ subject: 's', from: 'a@b.c', date: '2026-07-04T09:00:00Z', body: 'b', userId, _runClaude: email });
  const conn = capturing(CLASSIFY_JSON);
  await classifyConnectorItem({ userId, source: 'Miro', title: 't', date: '2026-08-01', text: 'x', _runClaude: conn });
  const q = capturing(QUESTION_JSON);
  await draftQuestion({
    plan: { title: 'p', goal: 'g', tasks: [] },
    transcriptWindow: [{ speaker: 'A', text: 'hello', ts: Date.now() }],
    userId, _runClaude: q,
  });
  return { calls: [sum.calls[0], email.calls[0], conn.calls[0], q.calls[0]], summary, emailOut };
}

test('internal helpers use the features.internal route when it resolves', async () => {
  const userId = freshUser();
  syncTierRouting({
    tiers: { cheap: { provider: 'openai', model: 'gpt-5-mini' } },
    features: { internal: 'cheap' },
  }, userId);
  const { calls, summary, emailOut } = await runInternalHelpers(userId);
  for (const c of calls) assert.deepEqual(c, { model: 'gpt-5-mini', provider: 'openai' });
  assert.equal(summary.model, 'gpt-5-mini', 'reported model is the one that ran');
  assert.equal(emailOut.model, 'gpt-5-mini');
});

test('internal helpers keep their default model when internal is not routed', async () => {
  const userId = freshUser();
  syncTierRouting({ tiers: { cheap: { provider: 'openai', model: 'gpt-5-mini' } } }, userId);
  const { calls } = await runInternalHelpers(userId);
  for (const c of calls) {
    assert.equal(c.provider, undefined, 'no provider forced on the default path');
    assert.notEqual(c.model, 'gpt-5-mini');
  }
});
