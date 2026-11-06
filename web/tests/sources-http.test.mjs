// The one guarded GET under both clients, and the preview rules. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer, guardedGet, isAllowedUrl, parseJson, checkQuery, readCapped, SourceError } from '../src/sources/http.ts';
import { decodeText, loadPreview, previewKind, CAPS } from '../src/sources/preview.ts';

const auth = (tokens = ['t1'], refreshTo = 't2') => { let i = 0; return { refreshes: 0, async token() { return tokens[i]; }, async refresh() { this.refreshes += 1; i += 1; tokens[i] = refreshTo; return refreshTo; } }; };
const free = { wait: async () => {} };
const err = (c) => (e) => { assert.ok(e instanceof SourceError, String(e)); assert.equal(e.code, c); return true; };
const res = (body, status = 200, headers = {}) => new Response(body, { status, headers });

test('host allow-list: https, exact hosts, no credentials, port 443 only', () => {
  for (const u of ['https://gitlab.com/api/v4/projects', 'https://api.box.com/2.0/folders/0/items', 'https://dl.boxcloud.com/d/1/x/download', 'https://public.boxcloud.com/api/2.0/x'])
    assert.equal(isAllowedUrl(u), true, u);
  for (const u of ['http://gitlab.com/', 'https://gitlab.com.evil.example/', 'https://evil.boxcloud.com/', 'https://u:p@gitlab.com/', 'https://gitlab.com:8443/', 'https://account.box.com/', 'notaurl'])
    assert.equal(isAllowedUrl(u), false, u);
});

test('pacer spaces request starts by 60000/perMinute ms', async () => {
  const slept = [];
  const p = createPacer(60, { now: () => 0, sleep: async (ms) => { slept.push(ms); } });
  await p.wait(); await p.wait(); await p.wait();
  assert.deepEqual(slept, [1000, 2000]);
});

test('readCapped: exact cap is whole, one byte over is truncated', async () => {
  assert.deepEqual(await readCapped(res(new Uint8Array(4)), 4), { bytes: new Uint8Array(4), truncated: false });
  const r = await readCapped(res(new Uint8Array(5).fill(1)), 4);
  assert.equal(r.truncated, true); assert.equal(r.bytes.length, 4);
});

test('guardedGet: bearer token, no cookies; 401 refreshes once then retries; second 401 is signed_out', async () => {
  const seen = []; const a = auth();
  let n = 0;
  const g = await guardedGet('https://gitlab.com/api/v4/x', a, free, 100, { fetchImpl: async (u, init) => { seen.push(init); return n++ === 0 ? res('', 401) : res('{"ok":1}'); } });
  assert.equal(seen[0].headers.Authorization, 'Bearer t1');
  assert.equal(seen[1].headers.Authorization, 'Bearer t2');
  assert.equal(seen[0].credentials, 'omit');
  assert.equal(a.refreshes, 1);
  assert.deepEqual(parseJson(g), { ok: 1 });
  await assert.rejects(guardedGet('https://gitlab.com/x', auth(), free, 100, { fetchImpl: async () => res('', 401) }), err('signed_out'));
});

test('guardedGet: 429 waits Retry-After (capped 60 s) at most twice, then rate_limited; 202 is not_ready', async () => {
  const slept = [];
  let n = 0;
  const ok = await guardedGet('https://api.box.com/2.0/x', auth(), free, 100, { sleep: async (ms) => { slept.push(ms); }, fetchImpl: async () => (n++ < 2 ? res('', 429, { 'retry-after': n === 1 ? '3' : '999' }) : res('x')) });
  assert.equal(ok.status, 200);
  assert.deepEqual(slept, [3000, 60000]);
  await assert.rejects(guardedGet('https://api.box.com/2.0/x', auth(), free, 100, { sleep: async () => {}, fetchImpl: async () => res('', 429, { 'retry-after': '5' }) }), (e) => e.code === 'rate_limited' && e.retryAfterSec === 5);
  await assert.rejects(guardedGet('https://api.box.com/2.0/x', auth(), free, 100, { sleep: async () => {}, fetchImpl: async () => res('', 202, { 'retry-after': '1' }) }), err('not_ready'));
});

test('guardedGet: offline, network failure, refused host, redirect landing, status codes', async () => {
  let called = false;
  await assert.rejects(guardedGet('https://gitlab.com/x', auth(), free, 100, { online: () => false, fetchImpl: async () => { called = true; return res(''); } }), err('offline'));
  assert.equal(called, false);
  await assert.rejects(guardedGet('https://gitlab.com/x', auth(), free, 100, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), err('unreachable'));
  await assert.rejects(guardedGet('https://evil.example/x', auth(), free, 100, { fetchImpl: async () => res('') }), err('refused_host'));
  const landed = res('x'); Object.defineProperty(landed, 'url', { value: 'https://evil.example/' });
  await assert.rejects(guardedGet('https://api.box.com/2.0/files/1/content', auth(), free, 100, { fetchImpl: async () => landed }), err('refused_host'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('{"code":"cors_origin_not_whitelisted"}', 403) }), err('cors_origin'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('{}', 403) }), err('forbidden'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('', 404) }), err('not_found'));
  await assert.rejects(guardedGet('https://api.box.com/x', auth(), free, 100, { fetchImpl: async () => res('', 500) }), err('provider_error'));
  assert.throws(() => parseJson({ bytes: new Uint8Array([123]), truncated: true }), err('too_large'));
  assert.throws(() => parseJson({ bytes: new TextEncoder().encode('{'), truncated: false }), err('bad_response'));
  assert.equal(checkQuery('  hi  '), 'hi');
  assert.throws(() => checkQuery('   '), err('bad_query'));
  assert.throws(() => checkQuery('x'.repeat(201)), err('bad_query'));
});

test('preview rules: code, markdown, text, pdf, extracted (Box only), unsupported; HTML and SVG are source text', () => {
  const k = (n, p = 'gitlab') => previewKind(n, p).kind;
  assert.equal(k('src/app.ts'), 'code'); assert.equal(previewKind('a.py', 'gitlab').language, 'python');
  assert.equal(k('index.html'), 'code'); assert.equal(k('logo.svg'), 'code');
  assert.equal(k('README.md'), 'markdown');
  assert.equal(k('notes.txt'), 'text'); assert.equal(k('LICENSE'), 'text');
  assert.equal(k('deck.PDF'), 'pdf');
  assert.equal(k('plan.docx', 'box'), 'extracted'); assert.equal(k('plan.docx', 'gitlab'), 'unsupported');
  for (const n of ['logo.png', 'a.zip', 'movie.mp4', 'font.woff2', 'app.exe', 'db.sqlite']) assert.equal(k(n), 'unsupported', n);
  assert.equal(decodeText(new Uint8Array([104, 105])), 'hi');
  assert.equal(decodeText(new Uint8Array([104, 0, 105])), null);
  assert.equal(CAPS.text, 1_048_576); assert.equal(CAPS.pdf, 20_971_520);
});

test('loadPreview: text with truncation flag, binary demoted, pdf over cap refused, unsupported never fetched', async () => {
  const e = { id: '1', name: 'a.txt', kind: 'file', path: 'a.txt', size: null, detail: null, project: null };
  const got = (bytes, truncated = false) => async () => ({ status: 200, headers: new Headers(), bytes, truncated });
  const t = await loadPreview(e, previewKind('a.txt', 'box'), null, got(new TextEncoder().encode('hello'), true));
  assert.equal(t.text, 'hello'); assert.equal(t.truncated, true);
  const b = await loadPreview(e, previewKind('a.txt', 'box'), null, got(new Uint8Array([0, 1])));
  assert.equal(b.kind, 'unsupported'); assert.equal(b.reason, 'binary');
  const p = await loadPreview(e, previewKind('a.pdf', 'box'), null, got(new Uint8Array(3), true));
  assert.equal(p.reason, 'too_large'); assert.equal(p.bytes, null);
  let fetched = false;
  const u = await loadPreview(e, previewKind('a.png', 'box'), 'https://app.box.com/file/1', async () => { fetched = true; });
  assert.equal(u.reason, 'type'); assert.equal(fetched, false); assert.equal(u.webUrl, 'https://app.box.com/file/1');
});
