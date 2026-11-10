import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
process.env.NODE_ENV = 'test';

const { handleTaskRoutes } = await import('../routes/tasks.mjs');

function fakeRes() {
  const out = { status: null, body: null };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(text) { out.body = JSON.parse(String(text)); },
  };
}

test('GET /kb/tasks lists the catalog and never returns a prompt', async () => {
  const res = fakeRes();
  assert.equal(await handleTaskRoutes({ method: 'GET', url: '/kb/tasks', headers: {} }, res, { userId: 'u1', url: '/kb/tasks' }), true);
  assert.equal(res.out.status, 200);
  const tasks = res.out.body.tasks;
  assert.ok(Array.isArray(tasks) && tasks.length >= 1);
  const sources = tasks.find((t) => t.id === 'sources.update');
  assert.ok(sources);
  assert.equal(Object.hasOwn(sources.runner, 'prompt'), false);
});

test('POST /kb/tasks/:id/run refuses a caller without the host proof before reading the body', async () => {
  let bodyRead = false;
  const req = {
    method: 'POST',
    url: '/kb/tasks/sources.update/run',
    headers: {},
    async *[Symbol.asyncIterator]() { bodyRead = true; yield Buffer.from('{}'); },
  };
  const res = fakeRes();
  assert.equal(await handleTaskRoutes(req, res, { userId: 'u1', url: req.url }), true);
  assert.equal(res.out.status, 403);
  assert.equal(res.out.body.error.code, 'HOST_PROOF_REQUIRED');
  assert.equal(bodyRead, false);
});
