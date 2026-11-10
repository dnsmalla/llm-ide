# System review — 2026-11-10

Whole-system review of `main` at `1a178d93310c2d5c3f451e9f4da441b402a934c1`, after the
Software Factory Phase B merge and B5 (`issues.implement`), the URL-first remote server,
plan-task assignment, and the R-034 hardening batch.

Range reviewed: `6b766194..1a178d933` — 105 commits, 364 files, +20,522/−1,281.
Two independent read-only passes: security/authority/remote hub, and desktop/factory/UI.

**Verdict: no new Critical. Local solo mode is sound. A multi-member hub is still not
safe to expose publicly.** Nine Important defects remain; three are hub/remote blockers,
six are Factory/assignment reliability and data-loss paths.

Nothing here was run against a real hub, sshd, systemd, nginx, certbot, web or iPhone.
All findings are code-read plus targeted tests unless marked verified.

## Must fix before a public hub

1. **A hub admin can read the JWT secret and vault key.** `deploy/hub/llmide-core.service`
   exposes `LoadCredential` files under `/run/credentials/llmide-core.service/`, owned by
   the service uid. Agent Bash runs as that same uid, and `hubClampedMode`
   (`extension/kb/members.mjs:350-361`) still lets `teamRole === 'admin'` execute.
   `ProtectProc` does not hide `/run`. Restrict execute to `owner`, or run agent commands
   under a separate uid.

2. **The root rollback helper trusts an attacker-selectable snapshot path.**
   `deploy/hub/llmide-deploy:400-440` discovers `data.db.bak-*` in a directory the core uid
   can write; `:422-455` follows a symlink and copies it as root into `data.db`. An execute
   agent can plant a symlink to `/etc/llmide/vault.key` and read it after rollback. Refuse
   symlinks/non-regular files, check ownership, or let root write the snapshot path.

3. **Remote desktop Chat cannot start a turn on a hub.** `ui/screens/chat/controller.ts:485`
   sends `agentContext` without `projectId`. `agent-v2.mjs:578-605` refuses a hub turn with
   no project; `startHostTurn` is the only surface that supplies one. A local project gives
   `403 PROJECT_DENIED`; no project gives `NoProjectCard`. Send `remoteProjectId()` or derive
   it from the server-owned `chat_sessions.project_id`.

## Important — Factory / assignment

4. **A claimed phone command can run for six hours without terminating.**
   `ui/screens/loop/native/run-manager.ts:258-264` calls `onRunFinished` only when a run
   actually starts. `loadFactoryLoop=null`, a declined approval, an unmapped repo, or a
   missing worktree call `fail()` and return null. `bus-runner.ts:95-99` waits for every
   runId, while `reportProgress` renews the lease to the 6 h `CLAIM_TIMEOUT_MS`.

5. **Double-click Start creates duplicate runs/worktrees.** `ui/screens/factory/Board.tsx:198-207`
   starts synchronously per click; `run-manager.ts:198-207` dedupes only by runId, and a new
   mode gets a random runId. Two runs consume two slots; the board shows only the first.

6. **Ship-status refresh dies at ~80 shipped cards.** `Board.tsx:97-117` discards every
   fetched chunk on the first `429`. Chunks are 20 URLs on the `dispatch` bucket
   (capacity 4, 1/10 s), so the fifth chunk always fails and statuses stop updating.

7. **A Chrome plan rename wipes its project tag and every assignment.**
   `extension/src/sidepanel/hooks/usePlan.ts:47-53` saves without `meta`;
   `extension/kb/plans.mjs:28` replaces meta wholesale; the task DELETE cascades the 0075
   assignment rows. The plan leaves the project board and “Assigned to me”; only the
   assignment log keeps history.

8. **No product path tags a plan with a project.** `POST /kb/plan/save` accepts
   `meta.projectId`, but its only caller (`extension/src/lib/kb.ts:88-97`) cannot send meta
   and the planner returns none. `GET /projects/:id/plan-tasks` is empty by construction,
   and the Settings hint is a dead end without curl.

9. **The B5 lease has only 30 s of slack and no re-attach.** `LEASE_MS=90_000`
   (`extension/kb/bus-store.mjs:318`) vs a 60 s poll (`run-manager-host.ts:17`) and a 60 s
   sweep. One hidden-window timer delay marks the command interrupted while the desktop run
   continues; `finish` then gets `LEASE_LOST`. `listClaimableCommands` requires
   `job.state='queued'`, so the documented reclaim branch is unreachable.

## Minor

- **Auto Tasks Mac-only dead controls.** The schedule Edit/Save is enabled for Mac-only
  tasks and says “active while this page is open”, but `scheduledRunAllowed` can never fire
  them. An imported `enabled:true` cannot be turned off.
- **Watcher residuals.** The vanished-folder fix is correct, but a path that became a file
  still fails the whole set; a skipped folder is not re-added until the next sync; the test
  only asserts `is_ok`.
- **Discard can orphan worktrees.** Board discard removes only worktrees in the last
  snapshot; ShipPanel discard removes only the last run’s worktree.
- **Resume after a failed sendBack re-runs Intake + Plan** and overwrites `.factory` artifacts.
- **`latestRecords` scans only 2,000 lines**, so an old item can fall back to Inbox.
- **Run manager skips the Loop pre-run guards** (`isNativeRunnable`, `worktreeBlockedStage`).
- **Paused runs hold the concurrency cap** across project switches.
- **`finished` map leak** in `bus-runner` for board-started runs.
- **B5 `sendItems` ignores `existed`**, so a phone claim can duplicate a live board run.
- **Phone `ship:true`** is accepted, confirmed, then silently ignored; no client renders
  `readyToShip`/`shipped`.
- **Remote:** `https://[::1]` is rejected by the host regex; `RemoteProjectBar` does not
  persist the selection; connect() can claim restart when `restartApp` is absent.
- **Remote Issues → Factory** can write to a local project while the issue came from a hub.
- **Weak tests:** `review-screen-wiring` and `factory-wiring` assert source-text regexes.
- **Worktree safety residual:** the run manager does not re-check
  `system/loop-worktrees/<runId>` before artifact/testMap stages.
- **`writePathGate`** collapses `..` lexically before following symlinks; a gate answer and
  the kernel landing can disagree.
- **R-034 #20** `remote_update` version is still unvalidated before path interpolation.
- **R-034 #18:** classifier before cap, `usd_cap_month=0` unlimited with no flag, unbounded
  semaphore queue.
- **R-034 #19:** per-IP `authPublic` has no nginx `limit_req`; NAT offices still throttle.
- **Authority surfaces:** `/auth/me` returns unclamped classes; several raw `classRefusal`
  call sites bypass the clamp comment; `/kb/generate-code` class disagrees.
- **Two backup schedulers** can prune a pre-deploy snapshot a rollback points at.
- **`remote_ssh_confirm`** trusts a webview fingerprint without binding it to the last
  Test SSH result.

## Closed / verified in this range

- R-034 #1 hub member clamp, #2 repo allow-list project bounds, #3 codegen refs, #5 `/admin`
  edge, #7 SSH confirm, #8 rollback/migration-ahead, #9 extra-root grants, #11 pin mismatch,
  #12 local-mode wrapper, #13 per-tool recheck, #14 owner/team.yaml guards, #15
  visudo/cert preflight, #16 backup timer/off-host.
- Software Factory Phase B board, run manager, send-back, intake; Ship remains click-only.
- Plan-task assignment authorization holds on every store path.
- Explorer watcher vanished-folder fix; 5 cargo tests.
- Stage-exec extraction: no behaviour regression found in halt/repair/cancel/resume.
- Remote URL-first login/session/TLS trust reads correctly; no password stored.
- `/admin` edge, finalize byte caps, failed-login email throttle.

Still open from R-034: #4 (desktop hub surface), #17 (restart kills turns), #18, #19, #20.

## Verification run

```text
git rev-parse HEAD                     1a178d933
http-inventory --coverage              route coverage OK (306)
extension targeted                      hub clamp 5, repo scope 12, codegen 2,
                                       bus claim/lease/job 20, assignments 19,
                                       roles 30, ship 17, gates 14, auth 96,
                                       agent-v2 106, command-bus 56
cargo remote_*                         53 passed
cargo loop_worktree                    15 passed
cargo fs_watch                         5 passed
hub nginx/installer                    8 passed
UI factory/loop/settings/shell         152 + 47 passed
```

Not run: real hub, sshd/systemd/nginx/certbot, pinned TLS/proxy over TLS, real rollback,
web/iOS, external `claude` CLI path normalization, 80+ card board, end-to-end remote login.

## Recommended order

1. Hub execute containment (owner-only or separate uid).
2. Rollback snapshot trust.
3. Remote desktop chat `projectId`.
4. B5 terminal state + lease/re-attach.
5. Factory double-start + ship-status batching.
6. Assignment project tagging + rename preservation.
7. Auto Tasks Mac-only UI: make real or hide.
8. Remaining R-034 #17–#20 and minors.
9. External security review before any public hub.
