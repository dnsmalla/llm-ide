import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCapture } from '../routes/host-api/exec-run.mjs';

test('a setsid grandchild holding the pipe cannot outlive the timeout', async () => {
  const started = Date.now();
  const r = await runCapture('/bin/sh', ['-c', "perl -e 'use POSIX; setsid(); sleep 3' & echo x"], { timeout: 500 });
  assert.ok(Date.now() - started < 1500, `resolved after ${Date.now() - started} ms`);
  assert.equal(r.timedOut, true);
});

test('normal completion still captures all output', async () => {
  const r = await runCapture('/bin/sh', ['-c', 'echo out; echo err >&2'], { timeout: 5000 });
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'err\n');
  assert.equal(r.status, 0);
});
