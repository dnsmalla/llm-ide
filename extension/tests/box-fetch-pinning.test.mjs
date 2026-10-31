// Box content downloads: redirect hygiene, host allowlist, pinned DNS, size caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.LLMIDE_LOG_FILE = 'none';

const { _boxFetchForTests: boxFetch, _readCappedForTests: readCapped, isAllowedBoxUrl } = await import('../connectors/box.mjs');
const { makePinnedFetch } = await import('../server/pinned-fetch.mjs');

const redirect = (loc, status = 302) => new Response(null, { status, headers: { location: loc } });
const scripted = (steps) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), redirect: init.redirect }); return steps[calls.length - 1](url); };
  fn.calls = calls;
  return fn;
};

test('isAllowedBoxUrl: only https Box hosts', () => {
  for (const ok of ['https://api.box.com/2.0/x', 'https://dl.boxcloud.com/a', 'https://public.boxcloud.com/a']) assert.ok(isAllowedBoxUrl(ok), ok);
  for (const bad of ['http://api.box.com/x', 'https://evil.com/', 'https://api.box.com.evil.com/', 'https://notbox.com/', 'https://169.254.169.254/', 'https://127.0.0.1/', 'https://u:p@api.box.com/', 'https://api.box.com:8443/', 'file:///etc/passwd']) assert.ok(!isAllowedBoxUrl(bad), bad);
});

test('redirect to another allowed origin drops the bearer; same origin keeps it', async () => {
  const f = scripted([
    () => redirect('/same'),
    () => redirect('https://dl.boxcloud.com/signed?x=1'),
    () => new Response('ok'),
  ]);
  const res = await boxFetch('https://api.box.com/2.0/files/1', { token: 'SECRET', fetchImpl: f });
  assert.equal(await res.text(), 'ok');
  assert.equal(f.calls[0].auth, 'Bearer SECRET');
  assert.equal(f.calls[1].auth, 'Bearer SECRET');
  assert.equal(f.calls[2].auth, null, 'bearer must not follow a cross-origin redirect');
  assert.ok(f.calls.every((c) => c.redirect === 'manual'));
});

test('redirect to a non-Box host or private literal is refused before any request', async () => {
  for (const target of ['https://evil.example/x', 'https://169.254.169.254/latest/meta-data', 'http://127.0.0.1:8080/', 'https://localhost/']) {
    const f = scripted([() => redirect(target), () => { throw new Error('must not be reached'); }]);
    await assert.rejects(boxFetch('https://api.box.com/2.0/x', { token: 'T', fetchImpl: f }), (e) => e.code === 'BOX_FETCH_REFUSED', target);
    assert.equal(f.calls.length, 1);
  }
});

test('redirect loops are bounded', async () => {
  const f = scripted(Array.from({ length: 10 }, () => () => redirect('/again')));
  await assert.rejects(boxFetch('https://api.box.com/2.0/x', { token: 'T', fetchImpl: f }), /too many redirects/);
  assert.ok(f.calls.length <= 4);
});

test('an API-supplied content URL on a foreign host is refused (no bearer sent)', async () => {
  const f = scripted([() => { throw new Error('must not be reached'); }]);
  await assert.rejects(boxFetch('https://evil.example/steal', { token: 'T', fetchImpl: f }), (e) => e.code === 'BOX_FETCH_REFUSED');
  assert.equal(f.calls.length, 0);
});

test('allowlisted Box host that resolves to a private address is refused by the pin (DNS rebinding)', async () => {
  for (const addr of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1']) {
    const resolver = async () => [{ address: addr, family: addr.includes(':') ? 6 : 4 }];
    // Bypass the NODE_ENV=test stub so the real pin runs.
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    let pinned; try { pinned = makePinnedFetch({ resolver }); } finally { process.env.NODE_ENV = prev; }
    await assert.rejects(boxFetch('https://api.box.com/2.0/x', { token: 'T', fetchImpl: pinned }), (e) => e.code === 'SSRF_BLOCKED', addr);
  }
});

test('redirect hop that rebinds to a private address is refused by the pin', async () => {
  let n = 0;
  const resolver = async () => [{ address: ++n === 1 ? '203.0.113.9' : '10.1.2.3', family: 4 }];
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  let pinned; try { pinned = makePinnedFetch({ resolver }); } finally { process.env.NODE_ENV = prev; }
  // First hop would dial a TEST-NET address (no server): wrap to answer a redirect without dialling, then pin the second.
  let first = true;
  const f = async (url, init) => (first ? ((first = false), redirect('https://dl.boxcloud.com/x')) : pinned(url, init));
  await assert.rejects(boxFetch('https://api.box.com/2.0/x', { token: 'T', fetchImpl: f }), (e) => e.code === 'SSRF_BLOCKED');
});

test('size caps: content-length and streamed bodies over the cap are refused', async () => {
  await assert.rejects(readCapped(new Response('x', { headers: { 'content-length': '999' } }), 10), /larger than/);
  await assert.rejects(readCapped(new Response('0123456789ABCDEF'), 10), /larger than/);
  assert.equal(await readCapped(new Response('hello'), 10), 'hello');
});
