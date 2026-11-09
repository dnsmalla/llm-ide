# System re-review (2026-11-09)

Whole-system review of `main` at `6b766194`, after the three limitations batches
([plan](../plans/2026-11-08-system-limitations-fixes.md), reviews R-019 to R-025), the project-scoped team roles
([ADR 0022](../../decisions/0022-project-scoped-team-roles.md)) and the Remote SSH hub
([plan](../plans/2026-11-08-remote-server-modes.md), reviews R-026 to R-033). About 130 commits and 20k lines since the
2026-11-08 system review. Everything is pushed; CI is green on `6b766194`; the master plan dashboard is at 67% (133 done,
79 partial, 47 open of 259).

Method: two fresh whole-stack reads (the hub deploy and proxy stack; the project-scoped authority in the core) on top
of the per-batch reviews, plus a closure check of the twenty 2026-11-08 findings. Items 1 to 5 below were re-verified
in the code by the reviewer; 6 to 20 rest on the auditors' reads with spot checks where a file and line are cited.
Nothing was run against a real hub, SSH host or device. The coder's task list is `agent-coord/reviews/R-034-system-rereview.md`
(REQ-018).

**Verdict: local solo mode is in good shape. A hub with more than one person is not safe yet.** Three findings let one
engineer read or write beyond their grant, and two more mean a second person cannot be added or chat from a phone.
Fix 1 to 5 before any hub gets a second member. "Execute for members" must stay off on every hub until item 1 is closed.

## Closure of the 2026-11-08 findings

| State | Findings |
|---|---|
| Closed (15) | F1 TLS boot guard and role-based pairing · F3 per-user session cap and turn semaphore · F4 chat-path USD cap (one-shot rows still open, see 6) · F5 sync re-upload hash · F8 release gates and Node 22 (first signed run still pending) · F9 capture defaults, closed-panel banner, chunked finalize · F10 queue expiry and truncated notice (web) · F11 per-user full-text search, batched rebuild · F12 disabled-account token, `turn.end` audit · F14 90-day device tokens, stale manifest refusal, revoke reminder · F15 desktop cap notices, partial graph layout · F16 poller backoff, no stdio MCP on a hub (classify budget open) · F17 Box scheduling, truncated-file flag · F18 Node 22, CHANGELOG gate, regression in CI, live `mac/` reference gate · F19 interrupted reply kept, data-dir parent check |
| Partial (3) | F2 Host API prefs pass through, phone project commands exist, but hub turns are refused (4) · F6 backups in a worker, hub off-host copy and operator trust boundary still open (16) · F7 secrets over stdin for the desktop core only; the hub core still reads them from an env file (1) |
| Open (2) | F13 token overhead (bench-gated by the owner) · F20 three hand-ported sync implementations |

## Must fix (in this order)

1. **An execute-mode member can read the hub's JWT secret and vault key.** `deploy/hub/llmide-core.service:11-12`
   loads `/etc/llmide/core.env`, which holds `LLMIDE_JWT_SECRET` and `LLMIDE_VAULT_KEY`
   (`deploy/hub/llmide-deploy:154,167`). Agent Bash runs as the same `llmide` user; `/proc/<core pid>/environ` is
   readable by a same-user process; the unit has no `ProtectProc`. One shell command forges the owner's token and
   decrypts every stored provider key. **Fix:** clamp hub members (not owner or admin) to `read_only` in
   `authorizeAction` now; before `execute` is offered to members, run agent commands under a separate user.
   `ProtectProc=invisible` and `LoadCredential` are defence in depth, not the fix.

2. **The repo allow-list widens chat read and write roots past the project grant.**
   `extension/llm_agent/tools/handlers/repo-files.mjs:71-92` adds every `userRepoAllowlist` path as a readable root
   (`allowBroad`), `:113-120` and `engine.mjs:585-586,1571,1708` make them writable; `POST /auth/me/repos` is `fs.write`
   with no project check. An engineer on project A adds `/srv/B` and edits B through a chat on A; revoking them from B
   does not remove the row. The list also feeds `/kb/review/approve`, `/kb/ingest-scip` and `/kb/connect-git`.
   **Fix:** on a hub, drop allow-list roots inside a registered project the caller has no grant on, for reads and
   writes, and refuse `/auth/me/repos` paths inside another project's root. Test: engineer-of-A edit on B refused.

3. **Codegen reads any absolute path named in a plan's file refs.** `extension/routes/planning.mjs:134-160` stores
   refs verbatim; `extension/agents/codegen.mjs:33-46,201-223` reads `f.ref` with an lstat and a size check only.
   A ref of `/var/lib/llmide/…/data.db` or `~/.ssh/id_rsa` goes into the model prompt and may come back in the diff.
   **Fix:** contain refs to the caller's allow-list within the plan's project root; test that `/etc/hosts` is not read.

4. **On a hub every Host API and extension chat turn is refused.** `extension/routes/agent-v2.mjs:584-587` refuses a
   folder in no project; `:499` and `:1283` set the workspace to `<dataDir>/extension-chat`
   (`core/extension-chat-workspace.mjs:14-18`, not per user), which belongs to no project. A phone's `chat.send` with a
   valid project answers `PROJECT_DENIED`. No hub test covers `startHostTurn`. **Fix:** exempt the `host-api` and
   `extension` surfaces from the folder rule while keeping the project grant check, and give the scratch folder a
   per-user subdirectory. Test both.

5. **Team settings and invites cannot work in remote mode.** `deploy/hub/llm-ide-hub.nginx.template:58-60` answers
   404 for `/admin` and `/admin/`; the desktop proxy forwards every request to that same public edge
   (`desktop/src-tauri/src/remote_proxy.rs:150`); `ui/screens/settings/team-model.ts:353-356` calls
   `/admin/members` and `/admin/invites`. R-032 closed R-026 #8 on the premise that the desktop bypasses the edge; it
   does not. The desktop (`ui/screens/shell/Panels.tsx:113-149`) and web register forms have no invite field.
   **Fix:** pass only `/admin/members`, `/admin/members/*` and `/admin/invites*` through nginx (the core gates them
   by JWT and role); keep the rest 404; add the invite field to both forms. Test through the proxy.

6. **Caps are blind to Loop runs, provider turns, codegen and one-shot Claude calls; the turn budget ignores the
   project cap.** `extension/routes/loop-agent.mjs:70-97` records no cost or project id (the SDK run has
   `out.usage.costUsd` at `llm_agent/sdk/loop-agent.mjs:750`); `llm_agent/adapter/provider-turn.mjs:187-215` and
   `providers/runtime.mjs:382,476-483,628-636,840-846` write tokens only; `kb/usage.mjs:419` keeps null as null.
   `agent-v2.mjs:773` and `engine.mjs:1177-1187` give the SDK the member's remaining month, not the project's: project
   cap 5 USD, member 100 USD remaining, turn budget 100; member cap 0 gives a null budget. **Fix:** estimate cost in
   `recordUsage` when tokens exist and cost is null; pass cost and project id from `meterRun`; pass the project's
   remaining cap into `resolveBudget` and take the minimum. Tests: a Loop row has a non-null cost; project 5 /
   member 100 gives at most 5.

7. **First SSH contact is blind trust-on-first-use, and the secrets ride it.** `desktop/src-tauri/src/remote.rs:192-210`
   uses `StrictHostKeyChecking=accept-new`; `remote_deploy.rs:532-542` lets a deploy run without a prior Test SSH;
   `:445` sends the JWT and vault keys on that connection's stdin. **Fix:** deploy, update and uninstall require a
   Test SSH whose fingerprint the user confirmed in this session; connect with `StrictHostKeyChecking=yes` and a
   temporary known-hosts file holding only that key.

8. **Rollback restores code only; a forward migration is never reversed.** `deploy/hub/llmide-deploy:334-353` swaps
   symlinks and the version line; `:323-332` takes a pre-deploy snapshot nothing restores; `remote_deploy.rs:26-29`
   has no restore stage; `extension/kb/migrations.mjs:105-140` has no "database ahead of the code" check. Release N+1
   adds a NOT NULL column, its health gate fails, rollback to N: `/health` is green while inserts fail. **Fix:** a
   `restore-db` helper stage that rollback runs when the migration head rose during the deploy; the old code refuses
   a database ahead of it.

9. **Loop extra roots let a nested project's admin write the enclosing project's docs.**
   `extension/llm_agent/sdk/loop-agent.mjs:171-210` checks the shape and ancestry of an extra root but no grant;
   `routes/loop-agent.mjs:183-219`. **Fix:** `projectIdForFolder` plus `authorizeAction('model.exec', { projectId })`
   per extra root.

## Should fix

10. **The hub login session is never stored.** `desktop/src-tauri/src/remote_session.rs:73-89` store, load and clear
    are registered (`lib.rs:451-453`) but no UI calls them; the refresh token lives in JS memory, so every launch in
    remote mode asks for a password, and the plan's Phase 3 exit is unmet. Wire load, `/auth/refresh` and store on
    mount; clear on 401 and sign-out.
11. **A pin mismatch looks like a network outage, and nothing tests the pinned TLS handshake.**
    `remote_proxy.rs:184` maps every upstream error to `502 HUB_UNREACHABLE`; `remote_tls.rs:114-126` discards the
    mismatch text; proxy tests use plain HTTP; `remote_tls_pin` (`:203-214`) pins without a native confirm. Map the
    mismatch to its own code with a "Re-probe and trust" action; add rcgen tests for match, other pin and
    WebPKI-invalid; add `confirm::ask`.
12. **Local host commands are still callable from the remote-mode webview** (R-027 R-I3 residual).
    `require_local_mode` guards only `fs_ops.rs:1076` and `lib.rs:238`; git (24 commands), notes (5), project (8),
    Loop (8), clone (1) and self-heal (6) are open. One guard in the invoke wrapper with a remote-safe allow-list.
13. **Grants and caps are read once per turn or run.** `agent-v2.mjs:593-605`; a Loop may run 4 hours
    (`routes/loop-agent.mjs:49`); `canUseTool` never re-checks. A demotion does not stop in-flight edits or spend.
    Re-run `authorizeAction` in `canUseTool` and at each ledger write; abort on refusal.
14. **A project can lose every owner, and `team.yaml` edits can wipe or drop project grants silently.**
    `kb/projects.mjs:468-480` `removeProjectMember` has no self or last-owner guard; `kb/team-yaml.mjs:711-800`
    deletes every row of a registered project absent from a present `projects:` block; `:847-905` drops file-only
    project entries for emails without an account, which the global list keeps; project downgrades at boot log no
    warning. Mirror the global guards and the unknown-email merge; add the warning.
15. **The sudoers drop-in is never syntax-checked, and a first install without a certificate ends half-switched.**
    `remote_deploy.rs:336-374` installs it with no `visudo -cf`; `llmide-deploy:241-243` checks the certificate only
    after `bundle` switched the release. A bad drop-in locks the operator out of `sudo`. Check both in preflight.
16. **Hub backups stay on the hub disk and nothing watches them.** `deploy/hub/llmide-backup.service` is a oneshot
    with no timer; the in-process 24 h timer (`server.mjs:1537-1545,1673-1675`) stops when the core is down, which is
    when a failed update leaves it; `logrotate` and `logger.mjs:32` both rotate the same file. Daily timer, an
    off-host target set by deploy, last-backup age in diagnostics, one rotator.
17. **Every update or rollback restarts the only process and kills in-flight turns**
    (`llmide-deploy:323-332,351,370`); the busy counts from `GET /kb/agent-sdk` are unused. Refuse unless idle or forced.
18. **Cap edge cases.** The auto-mode classifier runs before the cap checks (`agent-v2.mjs:612` vs `:648-660`), so an
    over-cap member still spends on every message; the turn semaphore (`:188`, `core/semaphore.mjs:22-41`) has no
    queue bound and keeps timed-out waiters; `usd_cap_month = 0` means unlimited with no guard
    (`kb/members.mjs:185-188,355-357`); a user with no `members` row has no cap (`agent-v2.mjs:647-648`). Move the
    checks up; prune waiters; reject 0 behind an explicit unlimited flag; refuse a turn with no row.
19. **Two mismatches.** `/kb/generate-code` is `model.read` (member) in `route-authority.mjs:376` but `model.ask`
    (viewer) at project level (`planning.mjs:351`). The login throttle is per IP (`rate-limit.mjs:170`) and the hub
    nginx has no `limit_req`, so an office behind one NAT shares ten logins then one per second. Align the class;
    raise the hub per-IP capacity and document NAT.
20. **The update version string is not validated** before it names a local bundle file
    (`remote_deploy.rs:227-237,630-634`). Require `x.y.z`.

## Still open from earlier work

- A7: the iOS truncated-snapshot notice (iOS was frozen during the batch).
- B6: the email-classify per-run budget; the core has no batch endpoint to budget, so this needs a wire decision.
- C8: the packaged Windows and Linux smoke exists only in the tag-only release job and has never run.
- R-026 #4: an external security review before any hub is public.
- R-024 Lows L1 to L6 (web and iOS project picker edge cases).
- F6: the operator trust boundary of a hub (whoever holds the VPS reads every member's data) is still not written down in ADR 0021.

## What is proven and what is not

Proven by tests and CI: every batch item above the line, the role class matrix (97 project tests), the per-user
search partition, the sync change hash with a real clock, the hub boot guard, the backup worker stall test.

Not proven anywhere: a real `sshd`, `systemd`, nginx, certbot or Let's Encrypt run (the runbook's container run used a
stand-in core and a self-signed certificate); the pinned TLS handshake, mismatch and rotation; the proxy over TLS;
`visudo` on the sudoers file; rollback with a real migration; a hub session across a restart; team admin and invite
flows through the proxy; certificate renewal with `--reuse-key`; the packaged Windows and Linux apps.

## Decisions for the owner

| # | Question |
|---|---|
| D1 | Is "execute for hub members" a v1 feature? If yes, agent commands need a separate OS user before item 1 can be lifted. If no, record "owner and admin only" in ADR 0021. |
| D2 | The email-classify budget needs a batch contract (B6). Add one, or accept per-call metering only? |
| D3 | Record the hub operator trust boundary in ADR 0021, or move the vault master and JWT secret off the database host? |
| D4 | Run the first signed desktop build and one real update on a staging channel? |
