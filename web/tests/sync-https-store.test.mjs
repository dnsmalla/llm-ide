// The browser's own-server store on a fake fetch: exact URLs, no credentials/referrer/cache/redirects, status codes
// mapped to SYNC_* codes, paths and sizes checked before any request. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHttpsStore } from '../src/sync/https-store.ts';

const ID = 'A'.repeat(22);
function fakeFetch(replies = []) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const r = replies.shift() ?? { status: 404 };
    if (r.throw) throw new TypeError('Failed to fetch');
    return new Response(r.status === 204 || r.status === 404 ? null : (r.body ?? new Uint8Array()), { status: r.status, headers: r.headers });
  };
  return { fn, calls };
}
const code = (c) => (e) => { assert.equal(e.code, c); return true; };

test('GET maps 200 to bytes and 404 to null, with a private, uncached, redirect-free request', async () => {
  const f = fakeFetch([{ status: 200, body: new Uint8Array([1, 2]) }, { status: 404 }]);
  const s = openHttpsStore('llm-ide.com', { fetchFn: f.fn });
  assert.deepEqual([...await s.get(`${ID}/d/${ID}/key.bin`)], [1, 2]);
  assert.equal(await s.get(`${ID}/d/${ID}/wrap.bin`), null);
  assert.equal(f.calls[0].url, `https://llm-ide.com/sync/${ID}/d/${ID}/key.bin`);
  assert.equal(f.calls[0].method, 'GET');
  for (const [k, v] of Object.entries({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })) assert.equal(f.calls[0][k], v, k);
});

test('PUT accepts 201 and 204; 409, 413, 429 and others are coded; a failed fetch is SYNC_UNREACHABLE', async () => {
  const f = fakeFetch([{ status: 201 }, { status: 204 }, { status: 409 }, { status: 413 }, { status: 429 }, { status: 500 }, { throw: true }]);
  const s = openHttpsStore('llm-ide.com', { fetchFn: f.fn });
  const p = `${ID}/d/${ID}/in/0000000000001-${ID}.bin`;
  await s.put(p, new Uint8Array([1]));
  await s.put(p, new Uint8Array([1]));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_MISSING'));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_TOO_LARGE'));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_RATE_LIMITED'));
  await assert.rejects(s.put(p, new Uint8Array([1])), code('SYNC_IO'));
  await assert.rejects(s.get(p), code('SYNC_UNREACHABLE'));
  assert.equal(f.calls[0].method, 'PUT');
});

test('bad hosts, bad paths and oversized bodies never reach fetch; a closed store refuses', async () => {
  const f = fakeFetch();
  for (const h of ['LLM-IDE.com', 'localhost', 'llm-ide.com:8443', 'evil.com/x']) assert.throws(() => openHttpsStore(h, { fetchFn: f.fn }), code('SYNC_BAD_PATH'), h);
  const s = openHttpsStore('llm-ide.com', { fetchFn: f.fn });
  await assert.rejects(s.get('../x'), code('SYNC_BAD_PATH'));
  await assert.rejects(s.put(`${ID}/x.bin`, new Uint8Array(65537)), code('SYNC_TOO_LARGE'));
  await s.close();
  await assert.rejects(s.get(`${ID}/x.bin`), code('SYNC_IO'));
  assert.equal(f.calls.length, 0);
});
