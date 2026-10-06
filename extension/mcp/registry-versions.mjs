// Latest-version lookup for npx/uvx MCP server packages. Hosts are fixed and
// the name is validated BEFORE the URL is built, so a stored spec can never
// steer the request elsewhere.

import { isValidName, isValidVersion } from './package-spec.mjs';

const CACHE_MS = 60 * 60 * 1000;
// Failures are cached too, so a registry outage does not make every list load
// wait out the timeout again; short enough that recovery is noticed quickly.
const ERROR_CACHE_MS = 5 * 60 * 1000;
// Short because lookups run in parallel on a user-facing request.
const TIMEOUT_MS = 5_000;
const FINAL_PYPI_RE = /^\d+(\.\d+)*(\.post\d+)?$/;

const cache = new Map();

export function _resetRegistryCacheForTests() {
  cache.clear();
}

function pypiKey(version) {
  const [main, post] = version.split('.post');
  return { nums: main.split('.').map(Number), post: post === undefined ? -1 : Number(post) };
}

function comparePypi(a, b) {
  const x = pypiKey(a);
  const y = pypiKey(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.post - y.post;
}

function newestPypi(data) {
  let best = null;
  for (const [version, files] of Object.entries(data?.releases ?? {})) {
    if (!FINAL_PYPI_RE.test(version) || !Array.isArray(files) || files.length === 0) continue;
    if (files.every((file) => file?.yanked === true)) continue;
    if (best === null || comparePypi(version, best) > 0) best = version;
  }
  if (best) return best;
  const info = data?.info?.version;
  return typeof info === 'string' && FINAL_PYPI_RE.test(info) ? info : null;
}

function registryUrl(runner, name) {
  return runner === 'npx'
    ? `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`
    : `https://pypi.org/pypi/${name}/json`;
}

let testFetch = null;
/** Tests inject a fake fetch here so nothing reaches the network. Pass null to restore. */
export function _setRegistryFetchForTests(fn) {
  testFetch = typeof fn === 'function' ? fn : null;
}

export async function latestVersion({ runner, name } = {}, { fetchFn = testFetch ?? fetch, now = Date.now, force = false } = {}) {
  if ((runner !== 'npx' && runner !== 'uvx') || !isValidName(runner, name)) {
    return { error: 'invalid package name' };
  }
  const key = `${runner}:${name}`;
  const hit = cache.get(key);
  if (!force && hit) {
    if (hit.error !== undefined && now() - hit.at < ERROR_CACHE_MS) return { error: hit.error };
    if (hit.error === undefined && now() - hit.at < CACHE_MS) return { version: hit.version };
  }
  const fail = (error) => {
    cache.set(key, { at: now(), error });
    return { error };
  };
  try {
    const res = await fetchFn(registryUrl(runner, name), {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return fail(`registry answered ${res.status}`);
    const data = await res.json();
    const version = runner === 'npx' ? data?.latest : newestPypi(data);
    if (typeof version !== 'string' || !isValidVersion(runner, version)) {
      return fail('registry gave no usable latest version');
    }
    cache.set(key, { at: now(), version });
    return { version };
  } catch (err) {
    return fail(String(err?.message || err).slice(0, 200));
  }
}
