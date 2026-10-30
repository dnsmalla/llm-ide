---
title: Core job runner — spec
status: draft
---

This is the contract for the Node-side job runner, the prerequisite for moving Loop and Auto Tasks (automation-kit) off the Mac app. It is a **library only**: nothing in boot or HTTP uses it yet, so no existing caller changes behaviour and no route, `ALL_ENDPOINTS` entry or API version bump is involved.

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
| Handler | `async ({ job, signal, spawn, log }) => result`, or `{ run, resumable: true }` |
| Success / error | the result is stored as JSON; a thrown error becomes `failed` with its message |
| Cancel (queued) | becomes `cancelled` at once |
| Cancel (running) | `cancel_requested` is set and the job's `AbortSignal` fires; the final state is `cancelled` with `error = cancelled` |
| Cancel (finished) | refused (`already_finished`) |
| Quit (`stop()`) | every running job is aborted; it ends `cancelled` with `error = server_quit`; jobs still `queued` stay queued. After `2 x graceMs + 500 ms` any remaining child group gets SIGKILL |
| Boot (`start()`) | rows left `running` by a dead process are swept: `resumable` kinds go back to `queued` (attempts is kept, so the next run counts as attempt 2), the rest become `interrupted` with `error = server_restarted` |
| Process group | `ctx.spawn(cmd, args, opts)` starts the child detached in its own group; abort sends SIGTERM to the group and SIGKILL after `graceMs` (default 2000 ms); after the leader exits the group is swept with SIGKILL. Output is capped at 1,000,000 characters per stream |

## §4 Open decisions

- **Orphan children after a hard crash.** A SIGKILLed server cannot kill its children, and the table stores no pid (a reused pid could hit a stranger). The existing `providers/adapter/spawn-group.mjs` watchdog covers MCP launches only. Option: store the group id and verify the start time before killing on the next boot.
- **Retry policy.** There is none; a failed job stays failed.
- **Wiring.** Starting the runner after listen, calling `stop()` at shutdown, and the HTTP surface (enqueue, list, cancel) are left to the automation-kit step that first needs them.

Tests: `extension/tests/job-runner.test.mjs` (fake handlers, no model calls).
