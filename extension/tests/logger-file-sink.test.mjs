// The logger's on-disk crash sink: warn+ lines are persisted to a file
// (synchronously, so they survive process.exit(1) on uncaught_exception),
// info/debug are not, and each persisted line is valid greppable JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(__dirname, `_logger-sink-test-${process.pid}.log`);
for (const f of [logFile, `${logFile}.old`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

// resolveLogFile() reads LLMIDE_LOG_FILE at import time — set it first.
process.env.LLMIDE_LOG_FILE = logFile;
process.env.LLMIDE_LOG_LEVEL = 'error'; // console quieted; file sink must IGNORE this
const { logger } = await import('../core/logger.mjs');

test('warn and error are persisted; info/debug are not', () => {
  logger.debug('debug-line', { a: 1 });
  logger.info('info-line', { b: 2 });
  logger.warn('warn-line', { c: 3 });
  logger.error('uncaught_exception', { error: 'boom', stack: 'at x' });

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  const parsed = lines.map((l) => JSON.parse(l)); // every line must be valid JSON
  const msgs = parsed.map((p) => p.msg);

  assert.ok(!msgs.includes('debug-line'), 'debug must not be persisted');
  assert.ok(!msgs.includes('info-line'), 'info must not be persisted');
  assert.deepEqual(msgs, ['warn-line', 'uncaught_exception']);
  // fields round-trip
  const crash = parsed.find((p) => p.msg === 'uncaught_exception');
  assert.equal(crash.level, 'error');
  assert.equal(crash.error, 'boom');
  assert.ok(typeof crash.ts === 'string' && crash.ts.length > 0);
});

test('file sink ignores console minLevel (error) and still records warn', () => {
  // Covered above (warn-line persisted despite LLMIDE_LOG_LEVEL=error); pin it
  // explicitly so a future regression in the gate ordering is caught.
  const msgs = fs.readFileSync(logFile, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l).msg);
  assert.ok(msgs.includes('warn-line'));
});

test('logger.audit persists an info-level line to the file sink', () => {
  // Regression: `project_memory` logged its outcome at info and its own comment
  // claimed that made "is memory working?" answerable from the log. It did not —
  // the file sink is warn+, so `grep project_memory kb/server.log` returned
  // nothing whether capture succeeded, skipped, or found nothing. `audit` is the
  // narrow exception: info level (nothing is wrong), but written to disk.
  logger.audit('project_memory', { outcome: 'captured', added: 2 });
  const parsed = fs.readFileSync(logFile, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
  const line = parsed.find((p) => p.msg === 'project_memory');
  assert.ok(line, 'audit line must reach the on-disk log');
  assert.equal(line.level, 'info', 'still info — an audit event is not a warning');
  assert.equal(line.outcome, 'captured', 'fields round-trip');
  // ...and plain info is still NOT persisted, so audit stays a deliberate opt-in.
  logger.info('another-info-line', {});
  const after = fs.readFileSync(logFile, 'utf8');
  assert.ok(!after.includes('another-info-line'));
});

test('a broken stdout/stderr pipe does not crash logging (EPIPE is swallowed)', () => {
  // Regression: a broken log pipe to the supervising app threw EPIPE from
  // stream.write → uncaughtException → process.exit(1), flapping the backend.
  const orig = process.stderr.write;
  process.stderr.write = () => { const e = new Error('write EPIPE'); e.code = 'EPIPE'; throw e; };
  try {
    assert.doesNotThrow(() => logger.error('uncaught_exception', { error: 'pipe broke' }));
    assert.doesNotThrow(() => logger.warn('still alive', {}));
  } finally {
    process.stderr.write = orig;
  }
});

test('cleanup', () => {
  for (const f of [logFile, `${logFile}.old`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});
