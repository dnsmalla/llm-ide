// Tier-route fallbacks on the REAL /code-assist paths (re-review N-1/N-2).
//
//  • N-1: a routed provider the server cannot run must reach the client with
//    its code ON THE SSE STREAM (headers are already 200 by then), or the
//    Mac's narrow "retry once without the route" never matches.
//  • N-2: /code-assist builds its own runClaude wrapper for the agent loop;
//    a tier-routed plugin subagent's `routeFallback` must survive it, or the
//    subagent's fallback (and the broken-route pre-check) is silently lost.
//
// Driven through handleAIRoutes / handleCodeAssist with fake CLIs and a
// mocked Anthropic HTTP endpoint — never by calling runClaude directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-route-fallback-'));
process.env.LLMIDE_DB_PATH = path.join(tmp, 'test.db');
const pluginDir = path.join(tmp, 'plugins');
fs.mkdirSync(path.join(pluginDir, 'routed', 'agents'), { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'routed', 'plugin.json'),
  JSON.stringify({ name: 'routed', version: '0.1.0', displayName: 'R', description: 't' }));
fs.writeFileSync(path.join(pluginDir, 'routed', 'agents', 'helper.md'),
  '---\ndescription: helps\ntier: strong\n---\nYou are the helper subagent. MARKER-SUBAGENT.');
process.env.LLMIDE_PLUGIN_DIR = pluginDir;

const db = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { setEnabled } = await import('../plugins/state.mjs');
const { syncTierRouting } = await import('../server/tier-routing.mjs');
const { _setCliProbeForTests } = await import('../providers/tier-routing.mjs');
const { _resetRouteHealthForTests } = await import('../providers/route-health.mjs');
const { handleAIRoutes, makeCodeAssistRunClaude } = await import('../server/ai-routes.mjs');
const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');

function freshUser() {
  return registerUser(db.getDb(), {
    email: `rf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@ex.com`,
    password: 'CorrectHorseBattery',
  });
}

// A CLI that exits 1 with nothing on stdout — the broken / logged-out shape.
function brokenCli() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brokencli-'));
  const bin = path.join(dir, 'cli');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Error: spawn /opt/x/codex ENOENT" >&2\nexit 1\n', { mode: 0o755 });
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function fakeReq(user, body, { sse }) {
  return {
    method: 'POST',
    url: '/code-assist',
    headers: sse ? { accept: 'text/event-stream' } : {},
    user: { id: user.id },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: null, chunks: [], writableEnded: false, headers: {},
    on() { return res; },
    once() { return res; },
    setHeader(k, v) { res.headers[k] = v; },
    writeHead(status) { res.statusCode = status; },
    write(chunk) { res.chunks.push(String(chunk)); },
    end(chunk) { if (chunk) res.chunks.push(String(chunk)); res.writableEnded = true; },
  };
  return res;
}

const sseEvents = (res) => res.chunks.join('')
  .split('\n\n').map((s) => s.trim()).filter((s) => s.startsWith('data: '))
  .map((s) => JSON.parse(s.slice(6)));

test('SSE /code-assist: a provider CLI that cannot run reaches the client as an error event WITH its code', async () => {
  _resetRouteHealthForTests();
  const user = freshUser();
  const cli = brokenCli();
  process.env.LLMIDE_OPENAI_CLI = cli.bin;
  try {
    const res = fakeRes();
    await handleAIRoutes(fakeReq(user, {
      message: 'hi', model: 'gpt-5', provider: 'openai', mode: 'ask',
      agentContext: { sessionId: 's-rf-1', recentIssues: [], indexedRepos: [] },
    }, { sse: true }), res);
    assert.equal(res.statusCode, 200, 'SSE headers were already written');
    const errors = sseEvents(res).filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'PROVIDER_UNAVAILABLE');
    assert.doesNotMatch(errors[0].error, /\/opt\/x/, 'no vendor path in the message');
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
    cli.cleanup();
    _resetRouteHealthForTests();
  }
});

test('SSE /code-assist: an ordinary failure carries no provider code', async () => {
  const user = freshUser();
  const res = fakeRes();
  // `provider` without `model` is route.mjs's fail-fast guard — a plain
  // validation error, not a provider-config refusal.
  await handleAIRoutes(fakeReq(user, {
    message: 'hi', provider: 'deepseek',
    agentContext: { sessionId: 's-rf-2', recentIssues: [], indexedRepos: [] },
  }, { sse: true }), res);
  const errors = sseEvents(res).filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.notEqual(errors[0].code, 'PROVIDER_UNAVAILABLE');
});

// ── N-2: routeFallback survives /code-assist's runClaude wrapper ─────────

function setupRoutedSubagent(user) {
  setEnabled(user.id, 'routed', true);
  syncTierRouting({ tiers: { strong: { provider: 'openai', model: 'gpt-5' } } }, user.id);
  _setCliProbeForTests(() => 'ok');
}

const FENCE = '<<<TOOL_CALL>>>\n{"name":"ask-subagent","arguments":{"name":"helper","question":"q"}}\n<<<END_TOOL_CALL>>>';

for (const sse of [false, true]) {
  test(`handleCodeAssist via the ${sse ? 'SSE' : 'buffered'} wrapper: a routed subagent's routeFallback reaches runClaude`, async () => {
    const user = freshUser();
    setupRoutedSubagent(user);
    const calls = [];
    const base = async (prompt, opts) => {
      calls.push({ subagent: /MARKER-SUBAGENT/.test(prompt), opts });
      if (calls.length === 1) return FENCE;
      return calls.length === 2 ? 'sub answer' : 'final answer';
    };
    try {
      const ac = new AbortController();
      const runClaude = makeCodeAssistRunClaude({
        userId: user.id, tierModel: undefined, composerProvider: undefined, signal: ac.signal,
        run: base, stream: sse ? base : undefined,
      });
      const out = await handleCodeAssist({
        message: 'ask the helper', history: [],
        agentContext: { recentIssues: [], recentMeetings: [] },
        runClaude, kb: { search: () => [], listMeetings: () => ({ items: [] }) }, userId: user.id,
      });
      assert.match(out.reply, /final answer/);
      const sub = calls.find((c) => c.subagent);
      assert.ok(sub, 'the subagent ran');
      assert.equal(sub.opts.provider, 'openai');
      assert.equal(sub.opts.model, 'gpt-5');
      assert.ok(sub.opts.routeFallback && typeof sub.opts.routeFallback === 'object', 'routeFallback forwarded');
      const global = calls.find((c) => !c.subagent);
      assert.equal(global.opts.routeFallback, undefined, 'the unrouted global hop carries none');
    } finally { _setCliProbeForTests(null); }
  });
}

test('buffered /code-assist end to end: a routed subagent whose CLI cannot run answers on the default', async () => {
  _resetRouteHealthForTests();
  const user = freshUser();
  setupRoutedSubagent(user);
  setSecret(db.getDb(), user.id, 'claude.apiKey', 'sk-ant-test');
  const cli = brokenCli();
  process.env.LLMIDE_OPENAI_CLI = cli.bin;
  const original = globalThis.fetch;
  const bodies = [];
  const replies = [FENCE, 'sub answer on default', 'final answer'];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init?.body || '{}');
    bodies.push(body);
    const text = replies[bodies.length - 1] ?? 'x';
    return {
      ok: true, status: 200, headers: new Map(),
      json: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }),
      text: async () => '{}',
    };
  };
  try {
    const res = fakeRes();
    await handleAIRoutes(fakeReq(user, {
      message: 'ask the helper', mode: 'ask',
      agentContext: { sessionId: 's-rf-3', recentIssues: [], indexedRepos: [] },
    }, { sse: false }), res);
    const payload = JSON.parse(res.chunks.join(''));
    assert.match(payload.reply, /final answer/);
    // global → subagent (on the default after its CLI failed) → global; a
    // fourth call may follow — the post-turn memory extractor.
    assert.ok(bodies.length >= 3);
    const subBody = JSON.stringify(bodies[1].messages);
    assert.match(subBody, /MARKER-SUBAGENT/);
  } finally {
    globalThis.fetch = original;
    delete process.env.LLMIDE_OPENAI_CLI;
    cli.cleanup();
    _setCliProbeForTests(null);
    _resetRouteHealthForTests();
  }
});
