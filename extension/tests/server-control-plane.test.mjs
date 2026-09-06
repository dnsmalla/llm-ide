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
    apiVersion: 19,
    endpoints: ['/generate-notes', '/kb/system/status'],
    serverStartedAt: startedAt,
  });

  assert.equal(payload.status, 'ok');
  assert.equal(payload.apiVersion, 19);
  assert.equal(payload.schemaVersion, 7);
  assert.ok(payload.uptimeSec >= 4);
  assert.deepEqual(payload.endpoints, ['/generate-notes', '/kb/system/status']);
  // skillsAvailable omitted here: undefined !== false, so it reads as available
  // (a caller unaware of the check, e.g. an older test, still gets 'ok').
  assert.deepEqual(payload.checks, { db: true, claude: true, claudeError: undefined, skills: true, skillsError: undefined });
});

test('buildHealthPayload reports degraded and a fix hint when .skills is not initialized', () => {
  const payload = buildHealthPayload({
    dbOk: true,
    claude: { ok: true },
    migration: { current: 7 },
    apiVersion: 44,
    endpoints: ['/generate-notes'],
    serverStartedAt: Date.now(),
    skillsAvailable: false,
  });

  // .skills is the only skill source now (no fallback copy) — see
  // docs/explanation/invariants.md — so this must degrade the overall
  // status, not just report a sub-field nobody checks.
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.checks.skills, false);
  assert.match(payload.checks.skillsError, /git submodule update --init \.skills/);
});

test('buildHealthPayload reports degraded dependencies without dropping the capability list', () => {
  const payload = buildHealthPayload({
    dbOk: false,
    claude: { ok: false, error: 'CLI not installed' },
    migration: null,
    apiVersion: 19,
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
