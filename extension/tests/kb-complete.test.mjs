// POST /kb/complete (agent-kit K1 P3): a plain one-shot completion. Fake model
// call only; no network, no paid call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-complete-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* first run */ } }

function makeReq({ method = 'POST', url = '/kb/complete', body }) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = {
    method, url, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
    once() { return req; },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    on() { return this; },
    once() { return this; },
    json() { return JSON.parse(this._body); },
  };
}

const { handleCompleteRoutes, COMPLETE_MAX_PROMPT_CHARS } = await import('../routes/complete.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { legacyBareCodeAssistPrompt } = await import('../core/prompt-framing.mjs');
const { codeAssistErrorResponse } = await import('../server/ai-routes.mjs');
const { recordUsage } = await import('../kb/usage.mjs');

async function call(body, run, userId = 'u1') {
  const res = makeRes();
  const handled = await handleCompleteRoutes(makeReq({ body }), res, { userId, url: '/kb/complete', run });
  return { handled, res };
}

test('other routes and methods are not handled', async () => {
  const res = makeRes();
  assert.equal(await handleCompleteRoutes(makeReq({ method: 'GET' }), res, { userId: 'u1', url: '/kb/complete' }), false);
  assert.equal(await handleCompleteRoutes(makeReq({}), res, { userId: 'u1', url: '/kb/completeX' }), false);
});

test('returns the trimmed reply and sends the prompt as is, tools-free', async () => {
  let seen;
  const { handled, res } = await call({ prompt: 'Say hi' }, async (p, o) => { seen = { p, o }; return '  hello \n'; });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reply, 'hello');
  assert.equal(seen.p, 'Say hi');
  assert.equal(seen.o.userId, 'u1');
  assert.equal(seen.o.tools, undefined);
  assert.equal(seen.o.endpoint, '/kb/complete');
  assert.equal(seen.o.model, undefined);
});

test('tier subagent resolves LLMIDE_SUBAGENT_MODEL; an explicit model wins', async () => {
  const saved = process.env.LLMIDE_SUBAGENT_MODEL;
  process.env.LLMIDE_SUBAGENT_MODEL = 'claude-haiku-5-5';
  try {
    let o1; await call({ prompt: 'x', tier: 'subagent' }, async (_p, o) => { o1 = o; return 'ok'; });
    assert.equal(o1.model, 'claude-haiku-5-5');
    let o2; await call({ prompt: 'x', tier: 'subagent', model: 'claude-opus-4-8', provider: 'anthropic' }, async (_p, o) => { o2 = o; return 'ok'; });
    assert.equal(o2.model, 'claude-opus-4-8');
    assert.equal(o2.provider, 'anthropic');
  } finally {
    if (saved === undefined) delete process.env.LLMIDE_SUBAGENT_MODEL; else process.env.LLMIDE_SUBAGENT_MODEL = saved;
  }
});

test("framing 'code-assist' is byte-identical to the legacy /code-assist prompt", async () => {
  let p;
  await call({ prompt: 'Why?', framing: 'code-assist', language: 'en' }, async (text) => { p = text; return 'ok'; });
  assert.equal(p, legacyBareCodeAssistPrompt('Always respond in English, even if the user writes in a different language.', 'Why?'));
  let q;
  await call({ prompt: 'Why?', framing: 'code-assist' }, async (text) => { q = text; return 'ok'; });
  assert.match(q, /Answer in the same language the user asks in\./);
  assert.match(p, /^You are a senior software-engineering assistant\./);
  assert.match(p, /# User\nWhy\?\n\nAssistant:$/);
});

test('validation: missing, non-string, empty, unknown framing, oversize', async () => {
  const run = async () => { throw new Error('must not run'); };
  for (const body of [{}, { prompt: 5 }, { prompt: '   ' }, { prompt: 'x', model: 3 }, { prompt: 'x', framing: 'nope' },
    { prompt: 'x'.repeat(COMPLETE_MAX_PROMPT_CHARS + 1) }]) {
    const { res } = await call(body, run);
    assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(res.json().error.code, 'VALIDATION_FAILED');
  }
  const res = makeRes();
  await handleCompleteRoutes(makeReq({ body: '{not json' }), res, { userId: 'u1', url: '/kb/complete', run });
  assert.equal(res.statusCode, 400);
});

test('provider-config refusal maps exactly as /code-assist (400 PROVIDER_UNAVAILABLE)', async () => {
  const err = Object.assign(new Error('No API key configured for DeepSeek.'), { code: 'PROVIDER_UNAVAILABLE' });
  const { res } = await call({ prompt: 'x', provider: 'deepseek' }, async () => { throw err; });
  const expected = codeAssistErrorResponse(err);
  assert.equal(res.statusCode, expected.status);
  assert.deepEqual(res.json(), expected.body);
  assert.equal(res.statusCode, 400);
});

test('any other failure is the generic 502 with no internals', async () => {
  const { res } = await call({ prompt: 'x' }, async () => { throw new Error('/secret/path claude exploded'); });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'INTERNAL_ERROR');
  assert.ok(!res._body.includes('/secret/path'));
});

test('usage reports summed model tokens when the call was metered', async () => {
  const { getDb } = await import('../kb/db.mjs');
  const { res } = await call({ prompt: 'x' }, async () => {
    recordUsage(getDb(), { userId: 'u1', provider: 'anthropic', model: 'claude-haiku-5-5', source: 'api', endpoint: '/kb/complete', inputTokens: 11, outputTokens: 3 });
    return 'ok';
  });
  assert.deepEqual(res.json().usage, { inputTokens: 11, outputTokens: 3, modelCalls: 1 });
});

test('wired into the KB router: an empty prompt answers 400 through handleKB', async () => {
  const res = makeRes();
  const req = makeReq({ body: { prompt: '' } });
  req.user = { id: 'u1' };
  const handled = await handleKB(req, res);
  assert.ok(handled !== false);
  assert.equal(res.statusCode, 400);
});

test('/kb/complete is advertised and rate-limited like /chat', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.mjs'), 'utf8');
  assert.match(src, /^\s*'\/kb\/complete',$/m);
  assert.match(src, /url === '\/kb\/complete'\)\s+return 'llmFast'/);
  assert.match(src, /const SERVER_API_VERSION = (8[8-9]|9\d|[1-9]\d\d);/);
});
