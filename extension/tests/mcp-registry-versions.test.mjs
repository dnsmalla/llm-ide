import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { latestVersion, _resetRegistryCacheForTests } from '../mcp/registry-versions.mjs';

beforeEach(() => _resetRegistryCacheForTests());

function fake(body, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('npm happy path, scoped URL encoded, redirect + timeout passed', async () => {
  const fetchFn = fake({ latest: '1.2.3' });
  const out = await latestVersion({ runner: 'npx', name: '@scope/pkg' }, { fetchFn });
  assert.deepEqual(out, { version: '1.2.3' });
  assert.equal(fetchFn.calls[0].url, 'https://registry.npmjs.org/-/package/%40scope%2Fpkg/dist-tags');
  assert.equal(fetchFn.calls[0].opts.redirect, 'error');
  assert.ok(fetchFn.calls[0].opts.signal instanceof AbortSignal);
});

test('PyPI skips pre-releases and yanked, picks newest final', async () => {
  const fetchFn = fake({
    info: { version: '3.0.0rc1' },
    releases: {
      '1.0.0': [{ yanked: false }],
      '1.10.0': [{ yanked: false }],
      '1.9.0': [{ yanked: false }],
      '2.0.0': [{ yanked: true }, { yanked: true }],
      '3.0.0rc1': [{ yanked: false }],
      '3.0.0.dev1': [{ yanked: false }],
      '1.10.0.post1': [{ yanked: false }],
    },
  });
  const out = await latestVersion({ runner: 'uvx', name: 'mcp-server-git' }, { fetchFn });
  assert.deepEqual(out, { version: '1.10.0.post1' });
  assert.equal(fetchFn.calls[0].url, 'https://pypi.org/pypi/mcp-server-git/json');
});

test('PyPI falls back to info.version when final', async () => {
  const out = await latestVersion({ runner: 'uvx', name: 'x' }, { fetchFn: fake({ info: { version: '0.5.0' }, releases: {} }) });
  assert.deepEqual(out, { version: '0.5.0' });
});

test('errors: invalid version, non-200, invalid name, throw', async () => {
  assert.ok((await latestVersion({ runner: 'npx', name: 'p' }, { fetchFn: fake({ latest: '1.0; x' }) })).error);
  assert.ok((await latestVersion({ runner: 'npx', name: 'p2' }, { fetchFn: fake({}, 404) })).error);
  const fetchFn = fake({ latest: '1.0.0' });
  assert.ok((await latestVersion({ runner: 'npx', name: '../x' }, { fetchFn })).error);
  assert.equal(fetchFn.calls.length, 0);
  const boom = async () => { throw new Error('offline'); };
  assert.deepEqual(await latestVersion({ runner: 'npx', name: 'p3' }, { fetchFn: boom }), { error: 'offline' });
});

test('cache hit, expiry and force', async () => {
  const fetchFn = fake({ latest: '1.0.0' });
  let clock = 1000;
  const opts = { fetchFn, now: () => clock };
  await latestVersion({ runner: 'npx', name: 'c' }, opts);
  await latestVersion({ runner: 'npx', name: 'c' }, opts);
  assert.equal(fetchFn.calls.length, 1);
  await latestVersion({ runner: 'npx', name: 'c' }, { ...opts, force: true });
  assert.equal(fetchFn.calls.length, 2);
  clock += 60 * 60 * 1000 + 1;
  await latestVersion({ runner: 'npx', name: 'c' }, opts);
  assert.equal(fetchFn.calls.length, 3);
});

test('error results are cached briefly, so a retry inside the window does not refetch', async () => {
  const bad = fake({}, 500);
  assert.ok((await latestVersion({ runner: 'npx', name: 'e' }, { fetchFn: bad })).error);
  const good = fake({ latest: '2.0.0' });
  assert.ok((await latestVersion({ runner: 'npx', name: 'e' }, { fetchFn: good })).error);
  assert.equal(good.calls.length, 0);
  assert.deepEqual(await latestVersion({ runner: 'npx', name: 'e' }, { fetchFn: good, force: true }), { version: '2.0.0' });
});

test('PyPI with no usable final version is an error', async () => {
  const out = await latestVersion({ runner: 'uvx', name: 'y' }, { fetchFn: fake({ info: { version: '1.0.0rc1' }, releases: { '1.0.0rc1': [{}] } }) });
  assert.ok(out.error);
});

test('errors are cached for 5 minutes (successes 1 h); force bypasses both', async () => {
  let clock = 0;
  const now = () => clock;
  let status = 503;
  const fetchFn = async () => ({ ok: status === 200, status, json: async () => ({ latest: '1.0.0' }) });
  const counting = (fn) => { const wrapped = async (...a) => { wrapped.n += 1; return fn(...a); }; wrapped.n = 0; return wrapped; };
  const f = counting(fetchFn);
  const spec = { runner: 'npx', name: 'neg-cache' };
  assert.ok((await latestVersion(spec, { fetchFn: f, now })).error);
  clock = 4 * 60 * 1000;
  assert.ok((await latestVersion(spec, { fetchFn: f, now })).error);
  assert.equal(f.n, 1, 'error served from cache inside 5 min');
  status = 200;
  assert.deepEqual(await latestVersion(spec, { fetchFn: f, now, force: true }), { version: '1.0.0' });
  assert.equal(f.n, 2, 'force bypasses the error cache');
  clock = 4 * 60 * 1000 + 30 * 60 * 1000;
  assert.deepEqual(await latestVersion(spec, { fetchFn: f, now }), { version: '1.0.0' });
  assert.equal(f.n, 2, 'success still cached after 30 min');
  const g = counting(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  clock = 10_000_000;
  await latestVersion({ runner: 'npx', name: 'neg-two' }, { fetchFn: g, now });
  clock += 6 * 60 * 1000;
  await latestVersion({ runner: 'npx', name: 'neg-two' }, { fetchFn: g, now });
  assert.equal(g.n, 2, 'error expires after 5 min');
});
