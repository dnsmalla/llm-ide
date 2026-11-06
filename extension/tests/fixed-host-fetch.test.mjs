// server/fixed-host-fetch.mjs: exact host list, no redirects, response size cap, over the pinned fetch.
// The transport is faked with _setPinnedFetchForTests; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { fixedHostFetch, capBody } = await import('../server/fixed-host-fetch.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');

const HOSTS = { hosts: ['api.example.com'] };
function fake(respond) {
  const calls = [];
  _setPinnedFetchForTests(async (url, init) => { calls.push({ url, init }); return respond(url, init); });
  return calls;
}
const why = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;

test('refuses another host, plain http, userinfo, an odd port, a bad URL and an empty list, before any request', async () => {
  const calls = fake(() => new Response('{}'));
  try {
    for (const url of ['https://evil.example/x', 'http://api.example.com/x', 'https://u:p@api.example.com/x',
      'https://api.example.com:8443/x', 'https://api.example.com.evil.example/x', 'not a url']) {
      await assert.rejects(fixedHostFetch(url, {}, HOSTS), (e) => e.code === 'FETCH_REFUSED', url);
    }
    await assert.rejects(fixedHostFetch('https://api.example.com/x', {}, { hosts: [] }), (e) => e.code === 'FETCH_REFUSED');
    assert.equal(calls.length, 0);
  } finally { _setPinnedFetchForTests(null); }
});

test('passes the request through with redirect manual and the normalised URL', async () => {
  const calls = fake(() => new Response('{"ok":true}', { status: 200, headers: { 'x-a': '1' } }));
  try {
    const res = await fixedHostFetch('https://API.example.com/v1?q=1',
      { method: 'POST', headers: { Authorization: 'Bearer t' }, body: 'b', redirect: 'follow' }, HOSTS);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-a'), '1');
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls[0].url, 'https://api.example.com/v1?q=1');
    assert.equal(calls[0].init.redirect, 'manual', 'a caller cannot turn redirects back on');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  } finally { _setPinnedFetchForTests(null); }
});

test('a redirect is never followed, so the credential never reaches the Location host', async () => {
  const calls = fake(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
  try {
    await assert.rejects(fixedHostFetch('https://api.example.com/x', { headers: { Authorization: 'Bearer t' } }, HOSTS),
      (e) => e.code === 'FETCH_REFUSED' && /redirect 302 not followed/.test(e.message));
    assert.equal(calls.length, 1);
  } finally { _setPinnedFetchForTests(null); }
});

test('a body over the cap fails while reading; one at the cap reads in full', async () => {
  fake(() => new Response('x'.repeat(10)));
  try {
    const big = await fixedHostFetch('https://api.example.com/x', {}, { ...HOSTS, maxBytes: 4 });
    await assert.rejects(big.text(), (e) => /larger than 4 bytes/.test(why(e)));
    const ok = await fixedHostFetch('https://api.example.com/x', {}, { ...HOSTS, maxBytes: 10 });
    assert.equal(await ok.text(), 'x'.repeat(10));
  } finally { _setPinnedFetchForTests(null); }
});

test('a test double that is not a Response passes through untouched', () => {
  const plain = { ok: true, status: 200, json: async () => ({}) };
  assert.equal(capBody(plain, 1), plain);
});
