// Self-Heal incident rules (core/incident.mjs), ported from the Mac app's IncidentRedactor, IncidentSignature and
// IncidentClassifier. Pure: no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactIncidentText, normalizeIncidentText, topOwnFrame, incidentSignature, environmentalReason, cleanIncident,
  MAX_MESSAGE, INCIDENT_STATUSES,
} from '../core/incident.mjs';

const GHP = `ghp_${'a'.repeat(36)}`;

test('redaction: shared secret shapes, JWTs, name=value secrets, emails and the home folder', () => {
  assert.equal(
    redactIncidentText(`token=abc boom 1 eyJa.b.c me@example.com /Users/dev/x ${GHP}`, 2000, '/Users/dev'),
    'token=[REDACTED] boom 1 [REDACTED] [EMAIL] ~/x [REDACTED]',
  );
  assert.equal(redactIncidentText('api_key: "s3cr3t", ok', 2000, ''), 'api_key: "[REDACTED]", ok');
  assert.equal(redactIncidentText('x'.repeat(10), 4, ''), 'xxxx…[truncated]');
  assert.equal(redactIncidentText(null, 10, ''), '');
});

test('normalization folds strings, uuids, paths, hex and numbers', () => {
  assert.equal(
    normalizeIncidentText('Failed "abc" for 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at /tmp/a.txt after 42 ms deadbeef00'),
    'Failed <str> for <uuid> at <path> after <n> ms <hex>',
  );
  assert.equal(normalizeIncidentText('  a \n\t b  '), 'a b');
});

test('the top own frame is the first stack line in extension/, desktop/ or ui/ outside node_modules', () => {
  const stack = 'Error: x\n    at a (node:internal/x:1:2)\n    at b (/r/node_modules/ui/x.js:1:1)\n    at c (~/llm-ide/extension/server.mjs:5:6)';
  assert.equal(topOwnFrame(stack), 'at c (~/llm-ide/extension/server.mjs:5:6)');
  assert.equal(topOwnFrame('Error: x\n    at a (node:internal/x:1:2)'), null);
  assert.equal(topOwnFrame(null), null);
});

test('the signature ignores numbers and line numbers but not the source, category or own frame', () => {
  const base = { source: 'server', category: 'server', message: 'timeout after 30 ms', stack: '    at c (~/x/extension/a.mjs:5:6)' };
  const sig = incidentSignature(base);
  assert.match(sig, /^[0-9a-f]{16}$/);
  assert.equal(incidentSignature({ ...base, message: 'timeout after 99 ms', stack: '    at c (~/x/extension/a.mjs:7:1)' }), sig);
  assert.notEqual(incidentSignature({ ...base, source: 'log' }), sig);
  assert.notEqual(incidentSignature({ ...base, category: 'GET /kb/x' }), sig);
  assert.notEqual(incidentSignature({ ...base, stack: '    at d (~/x/extension/a.mjs:5:6)' }), sig);
});

test('environmental reasons: offline, auth, permission, disk, configuration, cancelled, usage; app bugs are null', () => {
  assert.equal(environmentalReason('connect ECONNREFUSED 127.0.0.1:3456'), 'offline');
  assert.equal(environmentalReason('HTTP 403: forbidden'), 'auth');
  assert.equal(environmentalReason('EACCES: permission denied, open x'), 'permission');
  assert.equal(environmentalReason('ENOSPC: no space left on device'), 'disk');
  assert.equal(environmentalReason('Stage "build" has no runnable command'), 'configuration');
  assert.equal(environmentalReason('The operation was aborted'), 'cancelled');
  assert.equal(environmentalReason('usage: claude [options]'), 'usage');
  assert.equal(environmentalReason('TypeError: x is not a function'), null);
});

test('cleanIncident validates, redacts, caps, signs and classifies', () => {
  assert.equal(cleanIncident(null), null);
  assert.equal(cleanIncident({ source: 'evil', category: 'c', message: 'm' }), null);
  assert.equal(cleanIncident({ source: 'ui', category: 'chat', message: '   ' }), null);
  assert.equal(cleanIncident({ source: 'ui', category: 3, message: 'm' }), null);
  assert.equal(cleanIncident({ source: 'ui', category: 'chat', message: 'm', stack: 7 }), null);
  const c = cleanIncident({ source: 'ui', category: 'chat', message: `fetch failed for me@example.com ${'y'.repeat(3000)}` }, '');
  assert.equal(c.source, 'ui');
  assert.equal(c.category, 'chat');
  assert.ok(c.message.startsWith('fetch failed for [EMAIL] '));
  assert.equal(c.message.length, MAX_MESSAGE + '…[truncated]'.length);
  assert.equal(c.stack, null);
  assert.equal(c.environmental, 'offline');
  assert.match(c.id, /^[0-9a-f]{16}$/);
  assert.deepEqual([...INCIDENT_STATUSES], ['new', 'fixing', 'proposed', 'ignored', 'needsHuman', 'fixed']);
});
