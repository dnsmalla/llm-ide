// Every request to a MODEL provider host goes through the pinned fetch (server/pinned-fetch.mjs), so
// a DNS answer can never steer a key to a private address. This scans the provider layers for a bare
// global fetch( and allows only the fixed, code-owned hosts below (no user- or connection-supplied URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['providers', 'llm_agent', 'server', 'routes'];
// file -> how many bare fetch( calls it may hold, and why
const ALLOWED = {
  'providers/runtime.mjs': [2, 'api.anthropic.com, a fixed host'],
  'providers/web-client.mjs': [2, 'api.anthropic.com, plus the web-fetch tool whose every hop is re-checked by assertSafeBaseUrlResolved'],
  'providers/jev.mjs': [1, 'the operator-configured Jev decision API (JEV_AI_BASE_URL), not a user connection'],
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel, out); } else if (e.name.endsWith('.mjs')) out.push(rel);
  }
  return out;
}

test('no bare fetch( to a provider host outside the fixed-host allowlist', () => {
  const found = {};
  for (const f of DIRS.flatMap((d) => walk(d))) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const n = (src.match(/(^|[^.\w])fetch\(/gm) || []).length;
    if (n) found[f] = n;
  }
  for (const [f, n] of Object.entries(found)) {
    assert.ok(ALLOWED[f], `${f} calls the global fetch() ${n}x; use makePinnedFetch() (server/pinned-fetch.mjs) for provider requests`);
    assert.equal(n, ALLOWED[f][0], `${f}: expected ${ALLOWED[f][0]} bare fetch calls (${ALLOWED[f][1]}), found ${n}`);
  }
  for (const f of Object.keys(ALLOWED)) assert.ok(found[f], `${f} no longer has a bare fetch; drop it from the allowlist`);
});

test('the OpenAI-compatible, Google and model-list calls in providers.mjs use the pinned fetch', () => {
  const src = fs.readFileSync(path.join(root, 'providers/providers.mjs'), 'utf8');
  assert.ok(!/(^|[^.\w])fetch\(/m.test(src.replace(/^\s*\/\/.*$/gm, '')), 'providers.mjs has a bare fetch(');
  assert.ok((src.match(/makePinnedFetch\(\)\(/g) || []).length >= 4, 'callOpenAI, callGoogle, listProviderModels and the chat-route probe');
});
