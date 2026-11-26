// The extension chat scratch workspace and the v2 stream's extension surface (an extension turn needs no workspace path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_DB_PATH = path.join(os.tmpdir(), `ext-chat-workspace-${process.pid}.db`);

const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const { extensionChatWorkspace } = await import('../core/extension-chat-workspace.mjs');
const { getDb } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
// R-034 #18: a turn now needs a members row; this test is about the extension surface, not authority.
if (getDb().prepare("SELECT id FROM users WHERE id = 'u-410'").get() === undefined) {
  getDb().prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('u-410','u410@example.com','U','x','user','active')").run();
  grant(getDb(), 'u-410', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
}

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

test('extensionChatWorkspace is an existing, empty, server-owned directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-chat-ws-'));
  const dir = extensionChatWorkspace(root);
  assert.equal(dir, path.join(root, 'extension-chat'));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(extensionChatWorkspace(root), dir);
});

test('R-034 #4: the scratch workspace is per user and cannot escape the base folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-chat-ws-'));
  const a = extensionChatWorkspace(root, 'u-a');
  const b = extensionChatWorkspace(root, 'u-b');
  assert.equal(a, path.join(root, 'extension-chat', 'u-a'));
  assert.equal(b, path.join(root, 'extension-chat', 'u-b'));
  assert.notEqual(a, b);
  assert.ok(fs.statSync(a).isDirectory() && fs.statSync(b).isDirectory());
  // A hostile id is hashed, never used as a path segment.
  const evil = extensionChatWorkspace(root, '../../etc');
  assert.equal(path.dirname(evil), path.join(root, 'extension-chat'));
  assert.match(path.basename(evil), /^[a-f0-9]{32}$/);
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
  assert.equal(seen[0].agentContext.workspaceRoot, extensionChatWorkspace(undefined, 'u-410'));
  assert.equal(seen[0].mode, 'ask');

  const bad = makeRes();
  await handleAgentV2Routes(makeReq({
    url: '/agent/v2/stream',
    body: { message: 'hello', agentContext: { chatSessionId: 'c-mac' } },
  }), bad, deps);
  assert.equal(bad.statusCode, 400);
  assert.match(bad._body, /workspaceRoot is required/);
});
