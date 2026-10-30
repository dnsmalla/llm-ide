// Outbound-network guard for the whole extension/ tree (tests, node_modules, the browser src/ and build
// output excluded). A model-provider host, and any user-supplied URL the server fetches for a tool, must go
// through the pinned fetch (server/pinned-fetch.mjs): the hostname is resolved once by the socket itself,
// every address is classified, only a checked address is dialled, and redirects are refused or re-validated
// per hop. So this scan forbids, outside the small allowlist below:
//   - a bare `fetch(` / `fetch (` call,
//   - `globalThis.fetch` / `global.fetch` (a replaced fetch is how a guard is bypassed or faked),
//   - `http.request` / `https.request` / `http.get` / `https.get`,
//   - an `undici` import,
//   - a child process that runs `curl` or `wget`.
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
  globalFetch: /\b(globalThis|global)\.fetch\b/g,
  httpRequest: /\bhttps?\.(request|get)\s*\(/g,
  undici: /['"`]undici['"`]/g,
  curlSpawn: /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](curl|wget)\b/g,
};

// file -> rule -> { n: exact count, why }
const ALLOWED = {
  'providers/runtime.mjs': { bareFetch: { n: 2, why: 'api.anthropic.com, a fixed code-owned host (no user-supplied URL)' } },
  'providers/web-client.mjs': { bareFetch: { n: 2, why: 'api.anthropic.com (fixed) and serpapi.com (fixed, optional search fallback). The direct page fetch uses the pinned fetch' } },
  'providers/jev.mjs': { bareFetch: { n: 1, why: 'the operator-configured Jev decision API (JEV_AI_BASE_URL), not a user connection' } },
  'server/pinned-fetch.mjs': { globalFetch: { n: 3, why: 'the NODE_ENV=test seam that honours a replaced globalThis.fetch; never consulted in production' } },
  'connectors/google-oauth.mjs': { bareFetch: { n: 2, why: 'Google OAuth token and userinfo endpoints (fixed hosts)' } },
  'connectors/slack-oauth.mjs': { bareFetch: { n: 1, why: 'Slack OAuth token endpoint (fixed host)' } },
  'connectors/slack-source.mjs': { bareFetch: { n: 1, why: 'slack.com Web API (fixed host)' } },
  'connectors/box.mjs': { bareFetch: { n: 2, why: 'api.box.com and its OAuth token endpoint (fixed hosts)' } },
  'connectors/issues.mjs': { bareFetch: { n: 1, why: 'the user\'s issue tracker (GitHub/GitLab API host the user configured); not a model-provider path, pinning it is a separate task' } },
  'agents/slack.mjs': { bareFetch: { n: 1, why: 'Slack incoming webhook the user configured; not a model-provider path' } },
  'agents/github-pr.mjs': { bareFetch: { n: 1, why: 'api.github.com (fixed host)' } },
  'agents/outcome-providers.mjs': { bareFetch: { n: 3, why: 'api.github.com and api.linear.app (fixed), plus the user\'s GitLab/Backlog URL (redirect:error); not a model-provider path' } },
  'agents/dispatcher.mjs': { bareFetch: { n: 3, why: 'the user\'s issue-tracker endpoints (GitHub, GitLab, Backlog; redirect:error); not a model-provider path' } },
  // Self-tests embedded in the handlers (run via `node <file>`), which replace globalThis.fetch on purpose.
  'llm_agent/tools/handlers/fetch-url.mjs': { globalFetch: { n: 3, why: 'embedded self-test stands in for the network' } },
  'llm_agent/tools/handlers/web-search.mjs': { globalFetch: { n: 3, why: 'embedded self-test stands in for the network' } },
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
