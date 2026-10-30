#!/usr/bin/env node
// Runs `node <args>` (the `npm test` invocation) under a suite-level watchdog.
//
// `--test-timeout` bounds each test, but it cannot fire while a test is parked
// in a synchronous call (spawnSync) or when the runner itself is wedged. This
// wrapper is the last line: if the whole run outlives LLMIDE_TEST_SUITE_TIMEOUT_MS
// (default 25 min; the suite normally takes a few minutes) it prints the last
// test line seen (the one that stalled) and kills the run, so a stuck suite
// FAILS (exit 124) instead of hanging a push forever. It only ever kills the
// child it started.
import { spawn } from 'node:child_process';

const LIMIT_MS = Number(process.env.LLMIDE_TEST_SUITE_TIMEOUT_MS) || 25 * 60_000;
const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'inherit'] });

let lastLine = '';
let carry = '';
child.stdout.on('data', (d) => {
  process.stdout.write(d);
  const lines = (carry + d.toString()).split('\n');
  carry = lines.pop();
  for (const l of lines) if (/^\s*(ok|not ok) \d+ - /.test(l)) lastLine = l.trim();
});

const timer = setTimeout(() => {
  process.stderr.write(
    `\n[test-watchdog] suite exceeded ${Math.round(LIMIT_MS / 1000)}s with no exit; last finished test: ${lastLine || '(none)'}\n`
    + '[test-watchdog] killing the test run (see docs/how-to/test-hangs.md)\n',
  );
  child.kill('SIGKILL');
  process.exitCode = 124;
}, LIMIT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (process.exitCode === 124) return;
  process.exitCode = code ?? (signal ? 1 : 0);
});
