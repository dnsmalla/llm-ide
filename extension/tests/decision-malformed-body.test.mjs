// Both decision routes refuse a body that is not JSON with
// 400 VALIDATION_FAILED (SCHEMA.md "Malformed JSON bodies"), through the one
// shared reader in core/utils.mjs. A body that parses to a non-object reads as
// {} and gets the route's own "no pending decision" 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_decision-malformed-body-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { handleAIRoutes } = await import('../server/ai-routes.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');

const user = registerUser(getDb(), { email: 'decision-malformed@example.com', password: 'CorrectHorseBattery', displayName: 't' });

function rawReq(url, raw) {
  return {
    method: 'POST',
    url,
    user: { id: user.id },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(raw));
      if (event === 'end') cb();
    },
  };
}
function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    writeHead(code) { res.statusCode = code; },
    setHeader() {},
    end(chunk) { res.body = chunk ? JSON.parse(chunk) : null; },
  };
  return res;
}

const routes = [
  ['/code-assist/decision', (req, res) => handleAIRoutes(req, res)],
  ['/agent/v2/decision', (req, res) => handleAgentV2Routes(req, res)],
];

for (const [url, handle] of routes) {
  test(`POST ${url} answers 400 VALIDATION_FAILED for a body that is not JSON`, async () => {
    const res = fakeRes();
    assert.equal(await handle(rawReq(url, '{"requestId": '), res), true);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  test(`POST ${url} treats a JSON null body as {} (404, no pending decision)`, async () => {
    const res = fakeRes();
    assert.equal(await handle(rawReq(url, 'null'), res), true);
    assert.equal(res.statusCode, 404);
  });
}
