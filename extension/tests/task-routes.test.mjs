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

// A string[] arg arrives from the Host API as newline-separated text (its args are strings only).
async function runSourcesWithArgs(args) {
  const { busHostProof, BUS_PROOF_HEADER } = await import('../core/host-approval.mjs');
  const payload = Buffer.from(JSON.stringify({ args }));
  const { Readable } = await import('node:stream');
  const req = Object.assign(Readable.from([payload]), {
    method: 'POST',
    url: '/kb/tasks/sources.update/run',
    headers: { [BUS_PROOF_HEADER]: busHostProof() },
  });
  const res = fakeRes();
  await handleTaskRoutes(req, res, { userId: 'u1', url: req.url });
  return res.out;
}

test('run: a string[] arg accepts newline text (split, trimmed, blanks dropped) and still accepts an array', async () => {
  for (const sourceIds of ['a\r\n  b \n\n c', ['a', 'b', 'c']]) {
    const out = await runSourcesWithArgs({ sourceIds });
    assert.notEqual(out.body?.error?.code, 'VALIDATION_FAILED');
  }
});

test('run: a string[] arg given as text still enforces maxItems and maxLength', async () => {
  const tooMany = Array.from({ length: 51 }, (_, i) => `s${i}`).join('\n');
  for (const sourceIds of [tooMany, 'x'.repeat(129), 5]) {
    const out = await runSourcesWithArgs({ sourceIds });
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, 'VALIDATION_FAILED');
  }
});
