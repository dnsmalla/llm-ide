// Plan H1.2 Task 3: every route the server serves has exactly one class per method, and the table
// names no route that does not exist. The rosters are parsed from source (the server is never booted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET ||= 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY ||= 'b'.repeat(48);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadRosters } = await import('../../scripts/lib/roster.mjs');
const { ROUTE_POLICY, routeAuthorityFor } = await import('../server/route-authority.mjs');
const { CLASS_GRANTS } = await import('../kb/members.mjs');

const rosters = loadRosters((rel) => fs.readFileSync(path.join(REPO, rel), 'utf8'));
const rosterPaths = [...new Set([...rosters.endpoints, ...rosters.publicAuth].map((e) => e.path.split('?')[0]))];

// Served, but advertised by neither roster: admin-only operations and a diagnostics read.
const NON_ROSTER = new Map([
  ['/metrics', 'admin-only Prometheus text, deliberately not advertised by /health'],
  ['/admin/backup', 'admin-only, not advertised'],
  ['/admin/users/:userId', 'admin-only delete, not advertised (R-010#2)'],
  ['/kb/agent/diagnose', 'meeting-agent diagnostics read, not advertised'],
]);

test('every roster path has at least one policy rule', () => {
  const missing = rosterPaths.filter((p) => !ROUTE_POLICY.some((r) => r.path === p || r.re.test(p)));
  assert.deepEqual(missing, [], 'add these to ROUTE_POLICY with the class from the route inventory');
});

test('every rule names a known class and a served path', () => {
  for (const r of ROUTE_POLICY) assert.ok(r.cls in CLASS_GRANTS, `${r.method} ${r.path}: unknown class ${r.cls}`);
  const dead = ROUTE_POLICY.filter((r) => !NON_ROSTER.has(r.path) && !rosterPaths.some((p) => p === r.path || r.re.test(p)));
  assert.deepEqual(dead.map((r) => `${r.method} ${r.path}`), []);
});

test('a method + path has exactly one rule', () => {
  const seen = new Map();
  for (const r of ROUTE_POLICY) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate rule ${key}`);
    seen.set(key, r.cls);
  }
});

test('a literal path wins over a parameter path; the query string is ignored', () => {
  assert.equal(routeAuthorityFor('POST', '/kb/loop/agent-run?x=1').cls, 'model.exec');
  assert.equal(routeAuthorityFor('GET', '/kb/no-such-route'), null);
  assert.equal(routeAuthorityFor('GET', '/kb/loop/agent-run'), null, 'only the declared method');
});
