// extension/tests/code-assist-mode.test.mjs
//
// Task 5 of the code-assistant-modes-phase2 plan: /code-assist's HTTP layer
// (server/ai-routes.mjs) must forward body.mode into handleCodeAssist AND
// reflect the resolved out.mode back onto both response shapes (buffered
// JSON + SSE `done` event). route.mjs's handleCodeAssist already accepts and
// returns `mode` (see tests/route-modes.test.mjs) — this test exercises the
// thin HTTP plumbing in ai-routes.mjs on top of that, end to end.
//
// Why this test drives the REAL handleCodeAssist instead of mocking it:
// ai-routes.mjs does `import { handleCodeAssist } from '../llm_agent/runtime/route.mjs'`,
// a named ESM import. node:test's mock.method can't redefine an ESM named
// export (module namespace properties are non-configurable — this is the
// same issue documented in tests/route-modes.test.mjs for
// classifyCodeAssistMode), and mock.module() needs
// --experimental-test-module-mocks, unavailable on the Node 20 this repo's
// CI runs. So instead of mocking the import, we let the real call chain run
// and stub the ONE seam that's actually mockable this deep — the Anthropic
// HTTP call in providers/runtime.mjs's runClaude, via globalThis.fetch — the
// same technique tests/agent-loop.test.mjs and tests/agents-runtime.test.mjs
// already use for exactly this reason.
//
// With no body.model/body.provider, mode resolution runs the fence-loop
// branch (runAgentLoop) rather than the native tool-calling loop, and an
// ANTHROPIC_API_KEY env var (no per-user vault key) routes runClaude's HTTP
// path through the mocked fetch. A canned reply with no `<<<TOOL_CALL>>>`
// fence terminates the loop in a single iteration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-assist-mode-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleAIRoutes } = await import('../server/ai-routes.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function makeReq({ method, url, body, userId, headers = {} }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    headers,
    user: { id: userId },
    socket: { remoteAddress: '10.10.0.1' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    headersSent: false,
    ended: false,
    writeHead(code, h) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    get writableEnded() { return this.ended; },
  };
}

// A canned Anthropic Messages API response with NO <<<TOOL_CALL>>> fence —
// runAgentLoop returns it as the final reply on the very first iteration
// (see llm_agent/runtime/loop.mjs), so the turn completes deterministically
// in one fetch call regardless of the (heavy, real) system prompt built
// underneath it.
function stubAnthropicFetch(replyText) {
  return async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      return {
        ok: true,
        headers: new Headers(),
        json: async () => ({
          content: [{ type: 'text', text: replyText }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      };
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

test('POST /code-assist (buffered) threads body.mode into handleCodeAssist and returns the resolved mode', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `code-assist-mode-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'T',
  });

  const savedFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  globalThis.fetch = stubAnthropicFetch('Here is my plan: 1. Read the function 2. Write the docs.');

  try {
    const req = makeReq({
      method: 'POST',
      url: '/code-assist',
      userId: u.id,
      body: {
        message: 'how should I document this function?',
        agentContext: {},
        mode: 'plan',
      },
    });
    const res = makeRes();
    const handled = await handleAIRoutes(req, res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200, res._body);
    const json = JSON.parse(res._body);
    // The resolved mode must round-trip through the buffered response —
    // dropped silently before the fix because ai-routes.mjs enumerated
    // sendJSON's fields explicitly instead of spreading handleCodeAssist's
    // return value.
    assert.equal(json.mode, 'plan');
    assert.match(json.reply, /plan/i);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('POST /code-assist (buffered) defaults to execute mode when body.mode is omitted (back-compat)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `code-assist-mode-default-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'T2',
  });

  const savedFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  globalThis.fetch = stubAnthropicFetch('Sure, done.');

  try {
    const req = makeReq({
      method: 'POST',
      url: '/code-assist',
      userId: u.id,
      body: {
        message: 'add a hello world function',
        agentContext: {},
        // no mode field — must behave exactly like "execute".
      },
    });
    const res = makeRes();
    await handleAIRoutes(req, res);
    const json = JSON.parse(res._body);
    assert.equal(json.mode, 'execute');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
