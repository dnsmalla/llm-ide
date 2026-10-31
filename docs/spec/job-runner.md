---
title: Core job runner — spec
status: draft
---

This is the contract for the Node-side job runner, the prerequisite for moving Loop and Auto Tasks (automation-kit) off the Mac app. It is a library. Since API 100 the command bus ([command-bus](command-bus.md)) creates one runner after listen, calls `stop()` at shutdown and exposes it through `/bus/*`; the library itself is unchanged apart from two additive hooks: `enqueueJob` accepts an optional caller-chosen `id` (the bus gives a job its command's id) and `createJobRunner` accepts an optional `onSettled({ job, state, result, error })` callback that runs after the job row is settled (the bus appends its terminal event there; a throw in it never fails the settle).

Not covered here: the Mac-side Loop and Auto Task engines, which keep running as they do today until automation-kit moves their logic.

---

## §1 Files

| File | Role |
|---|---|
| `extension/kb/migrations/0055_jobs.sql` | the `jobs` table (main DB), additive and N-1 safe (an older server never reads it) |
| `extension/kb/job-queue.mjs` | data access: enqueue, get, list, cancel request, claim, finish, boot sweep |
| `extension/kb/job-runner.mjs` | `createJobRunner`: bounded drain loop, per-job abort, quit handling |
| `extension/core/process-group.mjs` | `runGrouped` and `killGroup`: spawn in its own process group, kill the whole group |

The modules import only `core/` and `kb/`, so the ESLint layer table is respected with no exemption.

## §2 Data model

`jobs(id, user_id, kind, lane, state, payload_json, result_json, error, attempts, cancel_requested, created_at, started_at, finished_at, updated_at)`. `user_id` references `users(id)` with `ON DELETE CASCADE` and `jobs` is in the account-delete list in `extension/kb/db.mjs`.

States: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`. Only `queued` and `running` are live.

**Lane lock.** A partial unique index `uq_jobs_lane_running ON jobs(user_id, lane) WHERE state = 'running'` allows at most one running job per user and lane. The database is the lock, so a second writer cannot break it. Claiming takes the oldest `queued` job whose user and lane have nothing running; other lanes and other users run in parallel.

**Tenancy.** Every per-user helper takes `userId` first and filters on it; a job of another user reads as not found. The `*System` helpers (`claimNextJobSystem`, `finishJobSystem`, `sweepInterruptedSystem`) are the runner's own cross-user operations and are not exposed to requests.

## §3 Runner behaviour

| Behaviour | Rule |
|---|---|
| Concurrency | at most `maxConcurrent` jobs run at once (default 2) |
| Handler | `async ({ job, signal, spawn, log }) => result`, or `{ run, resumable: true, timeoutMs? }` |
| Timeout | each job has a deadline (`timeoutMs`, else `jobTimeoutMs`, default 30 min): the job is aborted; a handler that ignores the abort is failed `timeout` after `graceMs` and its lane is freed, so a hung handler cannot hold it. A late result is ignored |
| Settling | the DB write that ends a job is guarded; the slot is always freed (try/finally) and the next job pumped, even when that write throws |
| Success / error | the result is stored as JSON; a thrown error becomes `failed` with its message |
| Cancel (queued) | becomes `cancelled` at once |
| Cancel (running) | `cancel_requested` is set and the job's `AbortSignal` fires; the final state is `cancelled` with `error = cancelled` |
| Cancel (finished) | refused (`already_finished`) |
| Quit (`stop()`) | every running job is aborted; it ends `cancelled` with `error = server_quit`; jobs still `queued` stay queued. After `2 x graceMs + 500 ms` any remaining child group gets SIGKILL |
| Boot (`start()`) | rows left `running` by a dead process are swept: `resumable` kinds go back to `queued` (attempts is kept, so the next run counts as attempt 2), the rest become `interrupted` with `error = server_restarted`. A row with `cancel_requested` is `cancelled` (never requeued); a resumable row that already ran `maxAttempts` times (default 3) is `failed` with `error = too_many_attempts`, so a poison job cannot crash-loop the server |
| Process group | `ctx.spawn(cmd, args, opts)` starts the child detached in its own group; abort sends SIGTERM to the group and SIGKILL after `graceMs` (default 2000 ms); after the leader exits the group is swept with SIGKILL only while it still has live members (an empty group's number may belong to a stranger), and the runner stops tracking the pid (`onExit`). With no `env` the child gets a sanitized default (`PATH`, `HOME`, `LANG`, `TMPDIR`, …, no `LLMIDE_*` or tokens); an explicit `env` is used as given, never merged with `process.env`. Output is capped at 1,000,000 characters per stream |

## §3a Quotas

`enqueueJob` refuses a payload over 64 KiB (`payload_too_large`) and a user with 100 jobs already queued or running (`quota_exceeded`); other users are unaffected.

## §4 Open decisions

- **Orphan children after a hard crash.** A SIGKILLed server cannot kill its children, and the table stores no pid (a reused pid could hit a stranger). The existing `providers/adapter/spawn-group.mjs` watchdog covers MCP launches only. Option: store the group id and verify the start time before killing on the next boot.
- **Retry policy.** There is none; a failed job stays failed.
- **Wiring.** Done by the command bus (S3): started after listen behind `LLMIDE_BUS=off`, stopped at shutdown, HTTP surface `/bus/commands`. Only kinds with a Node handler are registered (`review` today).

Tests: `extension/tests/job-runner.test.mjs` (fake handlers, no model calls).
