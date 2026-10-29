// The connect-time pin: every resolved address is classified, the checked one is
// the one dialled, a rebinding answer cannot slip in, and a refusal aborts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
const { makePinnedFetch, SsrfBlockedError } = await import('../server/pinned-fetch.mjs');

let hits = 0;
const server = http.createServer((req, res) => {
  hits += 1;
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/x' }); res.end(); return; }
  if (req.url === '/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: 1\n\n'); res.end('data: 2\n\n'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, host: req.headers.host, auth: req.headers.authorization ?? null, body })); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
after(() => server.close());

const resolverTo = (...answers) => {
  const calls = [];
  const fn = async (host) => { calls.push(host); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); };
  fn.calls = calls;
  return fn;
};
const open = () => true;
const blocked = (p) => assert.rejects(p, (e) => e instanceof SsrfBlockedError && e.code === 'SSRF_BLOCKED');

test('a private target needs BOTH the connection opt-in and the operator gate; then it connects to the checked address', async () => {
  const resolver = resolverTo(['127.0.0.1']);
  const f = makePinnedFetch({ allowPrivate: true, resolver, gate: open });
  hits = 0;
  const r = await f(`http://gateway.local:${port}/v1/models`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: '{"a":1}' });
  const j = await r.json();
  assert.deepEqual([r.status, j.path, j.auth, j.body, j.host], [200, '/v1/models', 'Bearer k', '{"a":1}', `gateway.local:${port}`]);
  assert.equal(resolver.calls.length, 1, 'one resolution, no second lookup to rebind');
  // operator gate closed: refused before any connection
  hits = 0;
  await blocked(makePinnedFetch({ allowPrivate: true, resolver: resolverTo(['127.0.0.1']), gate: () => false })(`http://gateway.local:${port}/x`));
  // connection opt-in absent: refused
  await blocked(makePinnedFetch({ allowPrivate: false, resolver: resolverTo(['127.0.0.1']), gate: open })(`https://api.example.com/x`));
  assert.equal(hits, 0, 'nothing reached the server');
});

test('every spelling a resolver can return for loopback or metadata is refused, and the socket is never opened', async () => {
  hits = 0;
  for (const bad of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '10.0.0.5', '100.64.1.1', 'fc00::5', '169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fd00:ec2::254', '0.0.0.0', 'fe80::1']) {
    await blocked(makePinnedFetch({ resolver: resolverTo([bad]) })(`https://api.example.com:${port}/x`));
  }
  assert.equal(hits, 0);
});

test('a mixed answer is refused when ANY address is non-public (no picking the good one)', async () => {
  await blocked(makePinnedFetch({ resolver: resolverTo(['8.8.8.8', '127.0.0.1']) })('https://api.example.com/x'));
  await blocked(makePinnedFetch({ resolver: resolverTo(['8.8.8.8', '::ffff:169.254.169.254']), allowPrivate: true, gate: open })('https://api.example.com/x'));
});

test('DNS rebinding: public first, loopback on the next resolution; the second request is refused', async () => {
  const resolver = resolverTo(['93.184.216.34'], ['127.0.0.1']);
  const f = makePinnedFetch({ resolver });
  // the first would dial 93.184.216.34 (not reachable here): it must get past the check and fail only on the network
  await assert.rejects(f('https://rebind.example.com/x', { signal: AbortSignal.timeout(300) }), (e) => !(e instanceof SsrfBlockedError));
  await blocked(f('https://rebind.example.com/x'));
  assert.equal(resolver.calls.length, 2);
});

test('IP-literal hosts are classified before any socket, in every spelling', async () => {
  for (const u of ['https://[::ffff:127.0.0.1]/x', 'https://[::ffff:a9fe:a9fe]/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://169.254.169.254/x', 'https://[fd00:ec2::254]/x']) {
    await blocked(makePinnedFetch({ resolver: resolverTo(['8.8.8.8']) })(u));
  }
  // never-class stays refused even with both opt-ins
  await blocked(makePinnedFetch({ allowPrivate: true, gate: open })('http://169.254.169.254/x'));
  await blocked(makePinnedFetch({ allowPrivate: true, gate: open })('http://[::ffff:169.254.169.254]/x'));
});

test('redirects are refused (the key rides in Authorization)', async () => {
  const f = makePinnedFetch({ allowPrivate: true, resolver: resolverTo(['127.0.0.1']), gate: open });
  await assert.rejects(f(`http://gateway.local:${port}/redirect`), /fetch failed/);
});

test('a streamed body arrives incrementally and an abort stops it', async () => {
  const f = makePinnedFetch({ allowPrivate: true, resolver: resolverTo(['127.0.0.1']), gate: open });
  const r = await f(`http://gateway.local:${port}/sse`);
  assert.equal(await r.text(), 'data: 1\n\ndata: 2\n\n');
  await assert.rejects(f(`http://gateway.local:${port}/x`, { signal: AbortSignal.abort() }));
});

test('plain http to a public-looking name and unsupported schemes are refused', async () => {
  await blocked(makePinnedFetch({ allowPrivate: true, gate: open, resolver: resolverTo(['8.8.8.8']) })('http://api.example.com/x'));
  await blocked(makePinnedFetch()('ftp://example.com/x'));
});
