// The direct web-fetch fallback (providers/web-client.mjs fetchUrl): every hop is pinned, a redirect to a
// private or metadata address is refused, hops are bounded and the body is capped. A real local server and a
// fake resolver; no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
const { makePinnedFetch, SsrfBlockedError } = await import('../server/pinned-fetch.mjs');
const { fetchUrl, MAX_FETCH_BODY_BYTES } = await import('../providers/web-client.mjs');

let hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.headers.host + req.url);
  if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Hello</title><body>fine page</body></html>'); return; }
  if (req.url === '/to-meta') { res.writeHead(302, { location: `http://meta.localhost:${port}/secret` }); res.end(); return; }
  if (req.url === '/loop') { res.writeHead(302, { location: `http://first.localhost:${port}/loop` }); res.end(); return; }
  if (req.url === '/hop') { res.writeHead(302, { location: `http://first.localhost:${port}/page` }); res.end(); return; }
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = Buffer.alloc(64 * 1024, 'a');
    let sent = 0;
    const pump = () => { while (sent < 6 * 1024 * 1024) { sent += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
    pump();
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
after(() => server.close());

const resolver = (map) => {
  const calls = [];
  const fn = async (host) => { calls.push(host); return (map[host] ?? ['8.8.8.8']).map((address) => ({ address, family: 4 })); };
  fn.calls = calls;
  return fn;
};
// first.localhost is "private" (127.0.0.1) and allowed for the test via the connection and operator opt-ins;
// meta.localhost resolves to the cloud metadata address, which no opt-in ever allows.
const pinned = (map) => makePinnedFetch({ allowPrivate: true, gate: () => true, resolver: resolver(map) });

test('a normal page is fetched through the pinned fetch and extracted', async () => {
  hits = [];
  const out = await fetchUrl(`http://first.localhost:${port}/page`, { fetchImpl: pinned({ 'first.localhost': ['127.0.0.1'] }) });
  assert.equal(out.title, 'Hello');
  assert.match(out.text, /fine page/);
});

test('DNS rebinding: a host that resolves to a private address is refused before any connection (default pin)', async () => {
  hits = [];
  const f = makePinnedFetch({ resolver: resolver({ 'rebind.example.com': ['127.0.0.1'] }) });
  await assert.rejects(fetchUrl(`https://rebind.example.com:${port}/page`, { fetchImpl: f }), (e) => e instanceof SsrfBlockedError || /SSRF guard/.test(String(e.message)) || e.code === 'SSRF_BLOCKED');
  assert.deepEqual(hits, [], 'no request reached the server');
});

test('a redirect to the metadata address is refused at the hop, even though the first hop was allowed', async () => {
  hits = [];
  const f = pinned({ 'first.localhost': ['127.0.0.1'], 'meta.localhost': ['169.254.169.254'] });
  await assert.rejects(fetchUrl(`http://first.localhost:${port}/to-meta`, { fetchImpl: f }), (e) => e.code === 'SSRF_BLOCKED' || e instanceof SsrfBlockedError);
  assert.ok(hits.some((h) => h.endsWith('/to-meta')) && !hits.some((h) => h.endsWith('/secret')), 'the metadata hop was never connected');
});

test('redirects are followed and bounded', async () => {
  const f = pinned({ 'first.localhost': ['127.0.0.1'] });
  const ok = await fetchUrl(`http://first.localhost:${port}/hop`, { fetchImpl: f });
  assert.equal(ok.title, 'Hello');
  await assert.rejects(fetchUrl(`http://first.localhost:${port}/loop`, { fetchImpl: f, maxRedirects: 3 }), /Too many redirects/);
});

test('an oversize body is streamed and cut at the cap, with a note', async () => {
  const f = pinned({ 'first.localhost': ['127.0.0.1'] });
  const out = await fetchUrl(`http://first.localhost:${port}/big`, { fetchImpl: f, maxBytes: 128 * 1024 });
  assert.match(out.text, /\[page truncated at 128 KB\]/);
  assert.ok(MAX_FETCH_BODY_BYTES === 2 * 1024 * 1024);
});
