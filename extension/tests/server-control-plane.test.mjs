import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHealthPayload,
  buildNotFoundDetails,
} from '../server/control-plane.mjs';

test('buildHealthPayload exposes schema version and full endpoint capability list', () => {
  const startedAt = Date.now() - 4_200;
  const payload = buildHealthPayload({
    dbOk: true,
    claude: { ok: true },
    migration: { current: 7 },
    apiVersion: 18,
    endpoints: ['/generate-notes', '/kb/system/status'],
    serverStartedAt: startedAt,
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.apiVersion, 18);
  assert.equal(payload.schemaVersion, 7);
  assert.ok(payload.uptimeSec >= 4);
  assert.deepEqual(payload.endpoints, ['/generate-notes', '/kb/system/status']);
  assert.deepEqual(payload.checks, { db: true, claude: true, claudeError: undefined });
});

test('buildHealthPayload reports degraded dependencies without dropping the capability list', () => {
  const payload = buildHealthPayload({
    dbOk: false,
    claude: { ok: false, error: 'CLI not installed' },
    migration: null,
    apiVersion: 18,
    endpoints: ['/generate-notes'],
    serverStartedAt: Date.now(),
  });

  assert.equal(payload.status, 'degraded');
  assert.equal(payload.schemaVersion, 0);
  assert.deepEqual(payload.endpoints, ['/generate-notes']);
  assert.equal(payload.checks.db, false);
  assert.equal(payload.checks.claude, false);
  assert.equal(payload.checks.claudeError, 'CLI not installed');
});

test('buildNotFoundDetails includes restart hint and advertised endpoints', () => {
  const details = buildNotFoundDetails(['/generate-notes', '/kb/system/status']);
  assert.match(details.hint, /Restart node server\.mjs/i);
  assert.deepEqual(details.endpoints, ['/generate-notes', '/kb/system/status']);
});
