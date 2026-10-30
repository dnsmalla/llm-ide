// POST /code-assist and /code-assist/decision answer 410 for one release (agent-kit K1 P6 T6.9): the
// classic engine is deleted, an old Mac app gets a clear "update the app" error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_DB_PATH = path.join(os.tmpdir(), `code-assist-removed-${process.pid}.db`);

const { handleAIRoutes, codeAssistRemovedBody } = await import('../server/ai-routes.mjs');

function req(url, body) {
  const chunks = [Buffer.from(JSON.stringify(body ?? {}))];
  let read = 0;
  const r = { method: 'POST', url, user: { id: 'u-410' }, headers: {}, on(e, cb) { if (e === 'data') { read += 1; chunks.forEach(cb); } else if (e === 'end') cb(); return r; }, once() { return r; }, get bodyRead() { return read > 0; } };
  return r;
}
function res() {
  return { statusCode: 200, _b: '', headers: {}, writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader() {}, write(c) { this._b += c; return true; }, end(c) { if (c) this._b += c; }, on() { return this; }, once() { return this; } };
}

for (const [url, use] of [['/code-assist', '/agent/v2/stream'], ['/code-assist/decision', '/agent/v2/decision']]) {
  test(`POST ${url} answers 410 ENDPOINT_REMOVED, names the replacement, and does not read the body`, async () => {
    const r = req(url, { message: 'hi', requestId: 'x' });
    const out = res();
    assert.equal(await handleAIRoutes(r, out), true);
    assert.equal(out.statusCode, 410);
    const body = JSON.parse(out._b);
    assert.equal(body.error.code, 'ENDPOINT_REMOVED');
    assert.match(body.error.message, /Update the app/);
    assert.deepEqual(body.error.details, { use, removedInApiVersion: 92 });
    assert.deepEqual(body, codeAssistRemovedBody(url));
    assert.equal(r.bodyRead, false, 'a removed route never reads (or buffers) the body');
  });
}

test('the 410 is cheap: /code-assist is no longer in the agent-turn rate bucket', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(url === '\/code-assist'\)\s+return 'llmFast'/);
});
