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
