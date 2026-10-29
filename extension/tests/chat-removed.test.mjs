// POST /chat answers 410 for one release (agent-kit K1 P4), and an extension
// turn needs no workspace path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_DB_PATH = path.join(os.tmpdir(), `chat-removed-${process.pid}.db`);

const { handleAIRoutes, chatRemovedBody } = await import('../server/ai-routes.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const { extensionChatWorkspace } = await import('../core/extension-chat-workspace.mjs');

function makeReq({ method = 'POST', url, body, user = { id: 'u-410' } }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers: {},
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
    statusCode: 200, headers: {}, _body: '', writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; return true; },
    end(chunk) { if (chunk) this._body += chunk; this.writableEnded = true; },
    on() { return this; },
    once() { return this; },
    json() { return JSON.parse(this._body); },
  };
}

test('POST /chat answers 410 ENDPOINT_REMOVED with a clear message, without reading the body', async () => {
  const res = makeRes();
  const handled = await handleAIRoutes(makeReq({ url: '/chat', body: { message: 'hi', transcript: 't' } }), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
  const body = res.json();
  assert.equal(body.error.code, 'ENDPOINT_REMOVED');
  assert.match(body.error.message, /Update the extension/);
  assert.equal(body.error.details.use, '/agent/v2/stream');
  assert.deepEqual(body, chatRemovedBody());
});

test('an old extension reading err.error.message gets the readable text', () => {
  // The shape the old useChat read: errorText(err, status) looks at error.message.
  assert.equal(typeof chatRemovedBody().error.message, 'string');
});

test('extensionChatWorkspace is an existing, empty, server-owned directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-chat-ws-'));
  const dir = extensionChatWorkspace(root);
  assert.equal(dir, path.join(root, 'extension-chat'));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(extensionChatWorkspace(root), dir);
});

test('v2 stream: surface extension needs no workspaceRoot; any other surface still does', async () => {
  const seen = [];
  const deps = {
    runTurn: async (args) => { seen.push(args); args.onEvent?.({ type: 'init', sessionId: 's1' }); return {}; },
    classifyMode: async () => ({ mode: 'ask' }),
    expandSlash: () => null,
  };
  const ok = makeRes();
  await handleAgentV2Routes(makeReq({
    url: '/agent/v2/stream',
    body: { message: 'hello', mode: 'ask', agentContext: { chatSessionId: 'c-ext', surface: 'extension' } },
  }), ok, deps);
  assert.equal(ok.statusCode, 200, ok._body.slice(0, 200));
  assert.ok(seen.length === 1);
  assert.equal(seen[0].agentContext.workspaceRoot, extensionChatWorkspace());
  assert.equal(seen[0].mode, 'ask');

  const bad = makeRes();
  await handleAgentV2Routes(makeReq({
    url: '/agent/v2/stream',
    body: { message: 'hello', agentContext: { chatSessionId: 'c-mac' } },
  }), bad, deps);
  assert.equal(bad.statusCode, 400);
  assert.match(bad._body, /workspaceRoot is required/);
});
