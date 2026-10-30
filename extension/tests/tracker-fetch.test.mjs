// Tracker-host pinning (connectors/issues.mjs, agents/dispatcher.mjs, agents/outcome-providers.mjs):
// every request resolves once, classifies every address, dials the checked one; private targets need
// BOTH the explicit opt-in and the operator gate; redirects never leave the host; tokens stay out of errors.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
const { makeTrackerFetch } = await import('../server/tracker-fetch.mjs');

let hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/same') {
    res.writeHead(301, { location: `http://gitlab.corp.local:${port}/final` });
    res.end();
    return;
  }
  if (req.url === '/other') {
    res.writeHead(302, { location: 'http://evil.local/x' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
after(() => server.close());

const resolverTo = (...addrs) => {
  const calls = [];
  const fn = async (h) => {
    calls.push(h);
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  fn.calls = calls;
  return fn;
};
const open = () => true;
const closed = () => false;
const refused = (p) => assert.rejects(p, (e) => e.code === 'SSRF_BLOCKED');

test('the data path works through the pin, with one resolution', async () => {
  // The data path is proved against the local server through the private opt-in; a public address is
  // simply not refused (the refusal tests below cover the other classes).
  const resolver = resolverTo('127.0.0.1');
  const f = makeTrackerFetch({ allowPrivate: true, gate: open, resolver });
  const r = await f(`http://gitlab.corp.local:${port}/api`, { headers: { authorization: 'Bearer t' } });
  assert.deepEqual(await r.json(), { path: '/api', auth: 'Bearer t' });
  assert.equal(resolver.calls.length, 1);
});

test('a hosted tracker (public address) is not refused by the guard', async () => {
  // Nothing needs to answer: the connect is aborted by the timeout. What matters is that the verdict is not SSRF_BLOCKED.
  for (const [host, addr] of [
    ['api.github.com', '140.82.112.5'],
    ['api.linear.app', '104.18.1.1'],
    ['team.backlog.com', '2606:4700::1111'],
  ]) {
    // A runner with real internet may even complete the request; only an SSRF verdict is a failure.
    await makeTrackerFetch({ resolver: resolverTo(addr) })(`https://${host}/x`, {
      signal: AbortSignal.timeout(250),
    }).catch((e) => {
      assert.notEqual(e.code, 'SSRF_BLOCKED');
    });
  }
});

test('public-looking host resolving to a private/metadata/loopback address is refused (rebinding), socket never opened', async () => {
  hits = [];
  for (const bad of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::ffff:169.254.169.254', 'fd00:ec2::254', '::1']) {
    await refused(makeTrackerFetch({ resolver: resolverTo(bad) })(`https://api.github.com:${port}/repos/o/r/issues`));
  }
  await refused(makeTrackerFetch({ resolver: resolverTo('140.82.112.5', '10.0.0.9') })('https://api.github.com/x'));
  assert.deepEqual(hits, []);
});

test('metadata stays refused even with the opt-in and the operator gate', async () => {
  await refused(
    makeTrackerFetch({ allowPrivate: true, gate: open, resolver: resolverTo('169.254.169.254') })(
      'https://tracker.corp/x',
    ),
  );
});

test('a private (self-hosted) tracker needs BOTH the opt-in and the operator gate', async () => {
  hits = [];
  await refused(
    makeTrackerFetch({ resolver: resolverTo('10.0.0.5'), gate: open })(`http://gitlab.corp.local:${port}/a`),
  ); // no opt-in
  await refused(
    makeTrackerFetch({ allowPrivate: true, resolver: resolverTo('10.0.0.5'), gate: closed })(
      `http://gitlab.corp.local:${port}/a`,
    ),
  ); // gate closed
  assert.deepEqual(hits, []);
  const ok = await makeTrackerFetch({ allowPrivate: true, resolver: resolverTo('127.0.0.1'), gate: open })(
    `http://gitlab.corp.local:${port}/a`,
  );
  assert.equal(ok.status, 200);
});

test('the refusal message names the private-network switches and never carries the token', async () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  await assert.rejects(
    makeTrackerFetch({ resolver: resolverTo('10.0.0.5'), secret: token })(
      `https://gitlab.corp.local/api?private_token=${token}`,
    ),
    (e) => e.code === 'SSRF_BLOCKED' && /LLMIDE_ALLOW_PRIVATE_PROVIDERS/.test(e.message) && !e.message.includes(token),
  );
});

test('redirects: refused by default; a read-only GET with followSameHost follows the same host only', async () => {
  const base = { allowPrivate: true, gate: open };
  await assert.rejects(
    makeTrackerFetch({ ...base, resolver: resolverTo('127.0.0.1') })(`http://gitlab.corp.local:${port}/same`),
    /fetch failed/,
  );
  const resolver = resolverTo('127.0.0.1');
  const f = makeTrackerFetch({ ...base, resolver, followSameHost: true });
  const r = await f(`http://gitlab.corp.local:${port}/same`);
  assert.equal((await r.json()).path, '/final');
  assert.equal(resolver.calls.length, 2, 'each hop is resolved and classified again');
  // a hop to another host is refused and never resolved
  const r2 = resolverTo('127.0.0.1');
  await assert.rejects(
    makeTrackerFetch({ ...base, resolver: r2, followSameHost: true })(`http://gitlab.corp.local:${port}/other`),
    /fetch failed/,
  );
  assert.deepEqual(r2.calls, ['gitlab.corp.local']);
  // a POST never follows, even with followSameHost
  await assert.rejects(
    makeTrackerFetch({ ...base, resolver: resolverTo('127.0.0.1'), followSameHost: true })(
      `http://gitlab.corp.local:${port}/same`,
      { method: 'POST', body: '{}' },
    ),
    /fetch failed/,
  );
});
