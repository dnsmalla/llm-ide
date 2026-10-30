// DeepSeek end to end on the real stack: POST /agent/v2/stream with the router on, a DeepSeek catalog
// connection, the real adapter turn and tool bridge, and a fake network (the pinned-fetch test seam).
// No model call is made; the stand-in speaks the OpenAI-compatible wire a DeepSeek endpoint speaks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_deepseek-e2e-ws');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_deepseek-e2e-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
const conns = await import('../server/provider-connections.mjs');
const models = await import('../providers/provider-models.mjs');
const db = getDb();
const U = registerUser(db, { email: `ds-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'ds' });

after(() => { _setPinnedFetchForTests(null); closeDb(); fs.rmSync(WS, { recursive: true, force: true }); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });
before(() => {
  process.env.LLMIDE_ROUTER = 'on';
  models._clearModelCacheForTests();
  conns.connectProvider(U.id, { catalogId: 'deepseek', apiKey: 'sk-ds-0123456789abcdef' }, db);
  conns.updateSettings(U.id, { toolsEnabled: true }, db);
});

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta, finish = null, usage) => sse({ id: 'x', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });

function network({ down = false } = {}) {
  const posts = [];
  _setPinnedFetchForTests(async (url, init = {}) => {
    const u = String(url);
    assert.ok(u.startsWith('https://api.deepseek.com'), `only the DeepSeek host is dialled, saw ${u}`);
    if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    posts.push(JSON.parse(init.body));
    if (down) return new Response('{"error":{"message":"upstream down"}}', { status: 503, headers: { 'content-type': 'application/json' } });
    const first = posts.length === 1;
    const body = first
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search-kb', arguments: '{"query":"launch plan"}' } }] })
        + chunk({}, 'tool_calls', { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 })
      : chunk({ role: 'assistant', content: 'The launch plan is not in your notes.' }) + chunk({}, 'stop', { prompt_tokens: 60, completion_tokens: 9, total_tokens: 69 });
    return new Response(`${body}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return posts;
}

function req(body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const r = { method: 'POST', url: '/agent/v2/stream', user: U, headers: {}, rateLimitRefund() {}, on(e, cb) { if (e === 'data') chunks.forEach(cb); else if (e === 'end' || e === 'close') cb(); return r; } };
  return r;
}
function res() {
  return { on() { return this; }, statusCode: 200, headers: {}, _b: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, write(c) { this._b += c; }, end(c) { if (c) this._b += c; this.ended = true; },
    events() { return this._b.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6))); } };
}
async function turn(chat, over = {}) {
  const out = res();
  await handleAgentV2Routes(req({ message: 'what is in my launch plan?', mode: 'ask', provider: 'custom:cat-deepseek', model: 'deepseek-chat',
    agentContext: { chatSessionId: chat, workspaceRoot: WS }, ...over }), out, {});
  return out;
}

test('a DeepSeek chat turn runs the tool loop through the adapter and streams a normal v2 answer', async () => {
  const posts = network();
  const out = await turn('ds-chat-1');
  assert.equal(out.statusCode, 200);
  const evs = out.events();
  const types = evs.map((e) => e.type);
  assert.ok(types.includes('init') && types.includes('tool_use_start') && types.includes('tool_result') && types.includes('result'), types.join());
  assert.equal(evs.find((e) => e.type === 'init').model, 'deepseek-chat');
  assert.match(evs.filter((e) => e.type === 'delta').map((e) => e.text).join(''), /launch plan is not in your notes/);
  assert.equal(posts.length, 2, 'one call for the tool, one for the answer');
  assert.ok(posts[0].tools.some((t) => t.function.name === 'search-kb'), 'our tools were offered on the wire');
  assert.ok(posts[1].messages.some((m) => m.role === 'tool'), 'the tool result went back to the model');
  const row = db.prepare("SELECT provider, model FROM usage_ledger WHERE user_id=? AND provider=?").get(U.id, 'custom:cat-deepseek');
  assert.equal(row.model, 'deepseek-chat');
  assert.ok(evs.find((e) => e.type === 'tasks'), 'the stream ends like a Claude turn (tasks event)');
});

test('execute mode on a model without tools is refused with a message that says what to do', async () => {
  network();
  const out = await turn('ds-chat-2', { mode: 'execute', model: 'unlisted-model' });
  const err = out.events().find((e) => e.type === 'error');
  assert.equal(err?.code, 'MODEL_LACKS_TOOLS');
  assert.match(err.message, /tools badge|Settings/);
});

test('the provider going down mid-conversation ends the turn with a retryable error and frees the chat', async () => {
  network({ down: true });
  const out = await turn('ds-chat-3');
  const err = out.events().find((e) => e.type === 'error');
  assert.equal(err?.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(err.retryable, true);
  assert.ok(!out._b.includes('sk-ds-0123456789abcdef'), 'the key never reaches the client');
  network();
  const again = await turn('ds-chat-3');
  assert.ok(again.events().some((e) => e.type === 'result'), 'the chat lock was released and the next turn runs');
});

test('router off: a catalog provider is refused with a clear code, never silently served by Claude', async () => {
  network();
  delete process.env.LLMIDE_ROUTER;
  try {
    const out = await turn('ds-chat-4', { runTurn: undefined });
    const err = out.events().find((e) => e.type === 'error');
    assert.ok(err, out._b.slice(0, 300));
    assert.match(String(err.code), /PROVIDER_NOT_AGENT_CAPABLE|PROVIDER_UNAVAILABLE|ENGINE_ERROR/);
  } finally { process.env.LLMIDE_ROUTER = 'on'; }
});
