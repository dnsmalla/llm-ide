// Host API v1 web Origin allowlist (core/host-api-origins.mjs) against the fixture the Mac host also runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOriginAllowlist, originRefused } from '../core/host-api-origins.mjs';

const fx = JSON.parse(readFileSync(new URL('../../schema/host-api/v1/fixtures/security/origins.json', import.meta.url)));

test('parse keeps the valid entries, normalised, and logs each dropped one', () => {
  const logged = [];
  const parsed = parseOriginAllowlist(fx.allowlist, (l) => logged.push(l));
  assert.deepEqual([...parsed], fx.parsed);
  assert.equal(logged.length, 7);
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual([...parseOriginAllowlist(undefined)], []);
});

test('every fixture case', () => {
  const parsed = parseOriginAllowlist(fx.allowlist);
  for (const c of fx.cases) {
    assert.equal(originRefused(c.origin === null ? {} : { origin: c.origin }, parsed), c.refused, JSON.stringify(c.origin));
  }
});

test('a non-string Origin is refused', () => {
  assert.equal(originRefused({ origin: ['http://localhost:5173'] }, ['http://localhost:5173']), true);
  assert.equal(originRefused({ origin: 5 }, ['http://localhost:5173']), true);
});
