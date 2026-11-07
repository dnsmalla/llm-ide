// Outbound-network guard for the whole extension/ tree (tests, node_modules, the browser src/ and build
// output excluded). A model-provider host, and any user-supplied URL the server fetches for a tool, must go
// through the pinned fetch (server/pinned-fetch.mjs): the hostname is resolved once by the socket itself,
// every address is classified, only a checked address is dialled, and redirects are refused or re-validated
// per hop. So this scan forbids, outside the small allowlist below:
//   - a bare `fetch(` / `fetch (` call,
//   - `globalThis.fetch` / `global.fetch` (a replaced fetch is how a guard is bypassed or faked),
//   - `http.request` / `https.request` / `http.get` / `https.get`,
//   - an `undici` import,
//   - a child process that runs `curl` or `wget`,
//   - a node:http2 import or http2.connect (only APNs, reviewed below).
// What this does NOT prove: that the allowlisted calls are safe; each entry states why it is allowed.
// What it DOES protect: no new network path can be added to the server without a reviewed entry here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'src', 'dist', 'coverage', '.git', '_site', 'build']);

const RULES = {
  bareFetch: /(^|[^.\w$])fetch\s*\(/g,
  // fetch passed or stored as a value (`fetchFn = fetch`, `f: fetch`), optional calls and bracket access.
  fetchRef: /(^|[^.\w$'"`/|-])fetch\b(?![\s(.:|-])/g,
  fetchOptional: /\bfetch\?\.\(/g,
  globalBracket: /\b(globalThis|global)\[\s*['"`]fetch['"`]\s*\]/g,
  globalFetch: /\b(globalThis|global)\.fetch\b/g,
  httpRequest: /\bhttps?\.(request|get)\s*\(/g,
  undici: /['"`]undici['"`]/g,
  curlSpawn: /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](curl|wget)\b/g,
  http2Import: /['"`](node:)?http2['"`]/g,
  http2Connect: /\bhttp2\.connect\s*\(/g,
};

// file -> rule -> { n: exact count, why }
const ALLOWED = {
  'server/pinned-fetch.mjs': { globalFetch: { n: 3, why: 'the NODE_ENV=test seam that honours a replaced globalThis.fetch; never consulted in production' } },
  // Self-tests embedded in the handlers (run via `node <file>`), which replace globalThis.fetch on purpose.
  'llm_agent/tools/handlers/fetch-url.mjs': { globalFetch: { n: 3, why: 'embedded self-test stands in for the network' } },
  'llm_agent/tools/handlers/web-search.mjs': { globalFetch: { n: 3, why: 'embedded self-test stands in for the network' } },
  'server/push/apns.mjs': {
    http2Import: { n: 1, why: 'APNs needs HTTP/2: two fixed Apple hosts (APNS_HOSTS), checked lookup, no redirects in the protocol' },
    http2Connect: { n: 1, why: 'the one http2.connect (defaultConnect), only to https://api.push.apple.com or api.sandbox.push.apple.com' },
  },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? path.join(dir, e.name) : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('_')) walk(rel, out); }
    else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}
// Only whole-line comments are dropped (a trailing // can sit inside a URL string); a rare false positive is fixed by an allowlist entry.
const strip = (src) => src.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

test('no new network path: every forbidden call outside the reviewed allowlist is a failure, and the allowlist is exact', () => {
  const found = {};
  for (const f of walk('')) {
    const src = strip(fs.readFileSync(path.join(root, f), 'utf8'));
    for (const [rule, re] of Object.entries(RULES)) {
      const n = (src.match(re) || []).length;
      if (n) (found[f] ??= {})[rule] = n;
    }
  }
  for (const [f, rules] of Object.entries(found)) {
    for (const [rule, n] of Object.entries(rules)) {
      const allowed = ALLOWED[f]?.[rule];
      assert.ok(allowed, `${f}: ${n}x ${rule}. Use makePinnedFetch() (server/pinned-fetch.mjs), or add a reviewed entry to this test with the reason`);
      assert.equal(n, allowed.n, `${f}: expected ${allowed.n}x ${rule} (${allowed.why}), found ${n}`);
    }
  }
  for (const [f, rules] of Object.entries(ALLOWED)) {
    for (const rule of Object.keys(rules)) assert.ok(found[f]?.[rule], `${f} no longer has ${rule}; drop it from the allowlist`);
  }
});

test('the OpenAI-compatible, Google and model-list calls in providers.mjs use the pinned fetch', () => {
  const src = fs.readFileSync(path.join(root, 'providers/providers.mjs'), 'utf8');
  assert.ok(!/(^|[^.\w])fetch\s*\(/m.test(strip(src)), 'providers.mjs has a bare fetch(');
  assert.ok((src.match(/makePinnedFetch\(\)\(/g) || []).length >= 4, 'callOpenAI, callGoogle, listProviderModels and the chat-route probe');
});

test('the three tracker-host callers use the pinned tracker fetch (their allowlist entries are gone)', () => {
  for (const f of ['connectors/issues.mjs', 'agents/dispatcher.mjs', 'agents/outcome-providers.mjs']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /makeTrackerFetch\(/, f);
    assert.equal(ALLOWED[f], undefined, `${f} must not be allowlisted`);
  }
});

test('the web-fetch tool fetches pages through the pinned fetch, hop by hop', () => {
  const src = fs.readFileSync(path.join(root, 'providers/web-client.mjs'), 'utf8');
  assert.match(src, /makePinnedFetch\(\)/);
  assert.match(src, /redirect: 'manual'/);
});

test('callOpenAI is only used inside providers.mjs (the classic loop that called it per hop is gone)', () => {
  const offenders = walk('').filter((f) => f !== 'providers/providers.mjs'
    && /\bcallOpenAI\b/.test(strip(fs.readFileSync(path.join(root, f), 'utf8'))));
  assert.deepEqual(offenders, []);
});

test('the deleted classic runtime files stay deleted', () => {
  for (const f of ['fence', 'loop', 'route', 'openai-tools']) {
    assert.equal(fs.existsSync(path.join(root, 'llm_agent/runtime', `${f}.mjs`)), false, f);
  }
});

test('every fixed-host caller goes through fixedHostFetch, and no bare fetch is allowlisted any more', () => {
  const want = { 'providers/runtime.mjs': 2, 'providers/web-client.mjs': 2, 'providers/jev.mjs': 1, 'connectors/google-oauth.mjs': 2, 'connectors/slack-oauth.mjs': 1, 'connectors/slack-source.mjs': 1, 'agents/slack.mjs': 1, 'agents/github-pr.mjs': 1 };
  for (const [f, n] of Object.entries(want)) { const src = strip(fs.readFileSync(path.join(root, f), 'utf8')); assert.equal((src.match(/\bfixedHostFetch\(/g) || []).length, n, f); assert.equal(ALLOWED[f], undefined, `${f} must not be allowlisted`); }
  assert.deepEqual(Object.entries(ALLOWED).filter(([, rules]) => rules.bareFetch).map(([f]) => f), []);
});

test('APNs dials only the two fixed Apple hosts, and Web Push only through fixedHostFetch', () => {
  const apns = strip(fs.readFileSync(path.join(root, 'server/push/apns.mjs'), 'utf8'));
  assert.match(apns, /APNS_HOSTS = Object\.freeze\(\{ production: 'api\.push\.apple\.com', sandbox: 'api\.sandbox\.push\.apple\.com' \}\)/);
  assert.match(apns, /connect\(`https:\/\/\$\{APNS_HOSTS\[environment\]\}`\)/);
  const wp = strip(fs.readFileSync(path.join(root, 'server/push/webpush.mjs'), 'utf8'));
  assert.match(wp, /fetchImpl = fixedHostFetch/);
  assert.match(wp, /\{ hosts: \[u\.hostname\], maxBytes: 16 \* 1024 \}/);
});
