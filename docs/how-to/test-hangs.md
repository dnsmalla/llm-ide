---
title: How to diagnose a hanging test run
applies_to: server
---

# How to diagnose a hanging test run

## Goal

Find out why `make test`, `make regression` or the pre-push gate stopped producing
output, and stop it from happening again.

## Built-in safety nets

- `npm test` (extension) runs under `extension/scripts/test-watchdog.mjs` with
  `--test-timeout=180000`. A single stuck test fails with its name after 3 minutes.
  The watchdog fails the whole run (exit 124, printing the last finished test) after
  25 minutes; override with `LLMIDE_TEST_SUITE_TIMEOUT_MS`.
- Tests that call `spawnSync` must pass `timeout` (and `killSignal: 'SIGKILL'`):
  a synchronous call blocks the event loop, so `--test-timeout` cannot interrupt it.
- Tests use ephemeral ports (`listen(0)`) and never rely on port 3456.

## Diagnose

1. Find the last test that finished: the TAP output ends with `ok N - name`; the next
   test in that file is the stuck one.
2. Run just that file with a hard cap:
   `cd extension && timeout 120 node --test --experimental-strip-types tests/<file>`.
3. In a second terminal, look at what is alive: `ps -axo pid,etime,pcpu,command | grep -E 'node|cargo'`.
   A runner at ~0 % CPU with no children is waiting on a timer or socket.
4. Slow rather than stuck? Use `--test-reporter=spec` to see per-test durations. A test
   that waits out a rate limiter (429) is slow by design; avoid it in fake servers.

## Laptop sleep

A laptop that sleeps mid-run freezes every timer and helper process, and a test can
look hung for as long as the machine slept. Keep it awake while a long gate runs:

```bash
caffeinate -dimsu make regression
```

## Stale leftover processes

Old agent runs can leave servers or test runners alive for days. They are harmless to
a fresh run (tests use their own ports) but hold memory and confuse diagnosis. List
them, then stop only the ones you recognise:

```bash
ps -axo pid,etime,command | grep -E 'server.mjs|node --test' | grep -v grep
kill <pid>        # polite; use kill -9 <pid> only if it ignores this
```

Do not kill the app backend on 127.0.0.1:3456 while the desktop app is in use.
