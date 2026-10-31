---
title: Command bus: the core job API
status: draft
---

One command and result contract for every client of the desktop core: the desktop UI, the Chrome extension and the iPhone (through the Mac host's WebSocket now, a relay later). This page is the contract of what is **implemented** (slices S1 and S3 of [the plan](../superpowers/plans/2026-10-31-command-bus-spec.md)); the plan carries the migration, the mobile audit and the open questions.

Not covered: the Swift transport host (S2), the iOS renderer (S4), the extension on the bus (S5) and the relay (S6).

---

## 1. Files

| File | Role |
|---|---|
| `schema/bus/registry.json` | **data**: kinds, tiers, client classes, limits, error codes. The Mac's tier gate can read it later |
| `schema/bus/command.schema.json`, `schema/bus/event.schema.json` | the command envelope and the result event envelope |
| `schema/bus/fixtures/` | conformance fixtures: commands (valid and invalid per kind), the tier matrix (every kind x every client class), approval rights, one event per type and per error code, event sequences (gap, two terminals, resume slice) |
| `scripts/conformance-bus.mjs` | validates all of it; part of `make contract-gates`. `--sync` copies the registry and the command schema next to the server |
| `schema/http/bus.schema.json`, `schema/http/fixtures/bus/` | the HTTP contract of the nine routes (generates `api-types.ts` and the OpenAPI document; the event schema is generated as `BusEvent`) |
| `extension/routes/bus/` | `registry.mjs` (registry copy + the pure tier gate `decideReceipt`), `schema-validate.mjs`, `sequence.mjs`, `client.mjs` (client class), `executor.mjs`, `bus-routes.mjs`, `engines.mjs`, `review.mjs` |
| `extension/kb/bus-store.mjs`, migration `0058_command_bus.sql` | persistence: `bus_commands`, `job_events`, `bus_kind_flags` |
| `extension/kb/job-queue.mjs`, `job-runner.mjs` | the existing job runner ([job-runner](job-runner.md)), now started by the bus |

The schema validator looks every key up as an OWN property (`Object.hasOwn`): a body key named `constructor`, `toString`, `valueOf`, `hasOwnProperty` or `__proto__` is an additional property and is refused `INVALID_ARGS` for the envelope and for every `kinds.<kind>.args` (`extension/tests/bus-schema-proto.test.mjs`).

`extension/routes/bus/registry.json` and `command.schema.json` are byte-identical copies (the extension must not read `schema/` at run time); the gate fails when they differ.

## 2. Envelopes

Command (`POST /bus/commands` body): `{ v?: 1, kind, args, idem, ttlMs?, createdAt? }`. `args` is typed per kind by the registry (`additionalProperties:false`; ids are `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`, never a path, a shell command or a provider key). `idem` is 1 to 64 characters. `origin`, `userId` and `deviceId` in the frame are ignored: the host decides them. The command id is assigned by the server and equals the job id (a client-chosen id is deferred; `idem` already makes a resend safe).

Event (`GET /bus/commands/:id/events`, SSE frame `id: <seq>` + `data: <json>`): `{ v, cmd, seq, type, payload, terminal, at }`. Types: `accepted`, `progress`, `chunk`, `data`, `needs_approval`, `ended`, `error`. `needs_answer` is reserved and absent until a kind asks questions. `seq` is per command, from 1, **gap-free** (assigned inside one transaction on the persisted `job_events` log); exactly one event has `terminal:true` (`ended` or `error`) and nothing follows it. A reader that dropped re-attaches with `?after=<last seq>` and gets every later event from the durable log, then live events; a stream also ends after 10 minutes (re-attach). At most 4 streams per user (429 `TOO_MANY_READERS`).

Bounds: command body 64 KiB; event payload 16 KiB (an oversize payload is shortened, never dropped); at most 5,000 rows and 4 MiB per command (at the cap one `progress` marker `events_truncated` is written, so `seq` stays gap-free, and a terminal event is always accepted); a stored result 256 KiB, redacted. Every payload and result string goes through the secret redactor and credential-named keys are replaced, so no key reaches a client.

## 3. Client class and the tier gate

The bearer token carries no client claim and the desktop UI and the extension hold the same kind of token, so the class comes from two request headers, **both capped**:

- `x-llmide-client`: `phone-pwa`, `extension`, `ios-native` or `desktop-ui` (advisory).
- `x-llmide-host-nonce`: the **host proof**, `hex(HMAC-SHA256(key, "bus-host-proof/v1"))` with `key` the hex-decoded `LLMIDE_HOST_APPROVAL_KEY` the host passes only to the core it spawned (64 lower-case hex characters, compared in constant time). It proves the caller is the host. It is a secret *derived* from the approval key and is **never** the `LLMIDE_CORE_NONCE` that `GET /health` echoes unauthenticated for core identity: that nonce is not a credential and raises nothing. The proof is a bearer secret equal in power to the Bypass key for bus approvals (approve, deny, list approval nonces, enable kinds): never log, store or send it to an adopted core. The header name is kept for wire compatibility.

With host proof the host vouches for the declared class (the Mac host forwards its phone as `ios-native` and its own UI as `desktop-ui`). Without it the class is **capped at `extension`**: a caller may declare a lower class, never a higher one; an absent or unknown header is `extension`; `relay-bridge` is not a class (a bridge declares the real client, with proof). With `LLMIDE_HOST_APPROVAL_KEY` unset or malformed (a standalone core) nobody can prove host, so `desktop-ui` is unreachable and **nothing can be approved** (fail closed). `LLMIDE_BUS_TRUST_CLIENT_HEADER=1` trusts the header; it exists for loopback development and the tests, is not advertised, and is **refused** when the server is bound to a non-loopback address (`LLMIDE_HOST`) or `NODE_ENV=production`.

| Class | May start tiers | May approve, deny, list approvals, set a kind's flag |
|---|---|---|
| `phone-pwa` | R | no |
| `extension` | R, C | no |
| `ios-native` | R, C, T0, T1, T2 (T1 and T2 only enqueue) | no |
| `desktop-ui` | all | yes |

`GET /bus/kinds` returns the registry as the caller sees it (`allowed`, `needsApproval`, `enabled`, `unavailableReason`), so clients never hard-code it.

Receipt gate (`decideReceipt`, pure, tested by `fixtures/tiers`): unknown kind refused; a class that may not start the tier is 403 `TIER_DENIED`; a kind that is not available is 501 `KIND_NOT_AVAILABLE`; T1 and T2 always wait for a desktop approval; a T0 kind started by anything but the desktop waits for approval unless the user's enable flag for the kind is on (flags are off by default and set only by `PUT /bus/kinds/:kind` from the desktop). Order of the checks at receipt: version, kind, schema and args, gate, project registered (404), quotas and idempotency.

**Approval.** A command that needs one is stored `awaiting_approval` **with no job**; the job is created only when the desktop approves. `GET /bus/approvals` (desktop class only) lists pending commands with their exact args and a per-command nonce, an HMAC of user, command and args under a per-process secret (recomputed on each read, never stored, never in an event). `POST /bus/commands/:id/approve { nonce, confirm? }` needs both the desktop class and the nonce, so a phone cannot approve its own command even if it learned the id; a T2 kind additionally needs `confirm` to repeat the exact `projectId`, `issueIds` and `ship` (400 `CONFIRM_MISMATCH`). An unapproved command expires (409 `EXPIRED`, terminal error `expired`); a deny ends it with a terminal error.

**Execution-time re-check** (the Auto Tasks audit finding F4: a phone run ignored the task's enable flag). Before an engine starts: the command is still inside its ttl, the kind is still available, the origin class may still start the tier, for an unapproved T0 from a remote origin the enable flag is **still on**, the user still exists, the project is still registered for the user and still on the repo allow-list (`user_repos`). Any failure is a terminal `error` with a fixed code (`expired`, `switch_off`, `project_not_registered`, `project_not_allowed`, ...), never a silent run.

## 4. Persistence, lanes, quotas

- `bus_commands(id, user_id, kind, tier, idem, args_hash, args_json, origin_client, approval_reason, state, approved_by, ttl_at, ...)`, `UNIQUE (user_id, idem)`: the same key with the same kind and args returns the original (HTTP 200, `deduped:true`), with other args 409 `IDEM_CONFLICT`; keys are per user.
- `job_events(job_id, seq, user_id, type, payload_json, terminal, bytes, at)`, primary key `(job_id, seq)`.
- `bus_kind_flags(user_id, kind, enabled)`.
- All three are additive (N-1 safe), carry `user_id` with `ON DELETE CASCADE` and are in the account-delete list. Finished commands and their events older than 7 days are purged.
- The job lane is `write:<projectId>` for write kinds and `read:<kind>:<projectId>` otherwise; the runner's database lock allows one running job per user and lane, so two writers never touch one project at once.
- Every size cap counts UTF-8 BYTES, never `String.length` (`routes/bus/bytes.mjs`): the engine text cap (256 KiB), the result cap (`maxResultBytes`, the whole serialized result including JSON escapes; only `text` is cut, `truncated: true`) and the `chunk` events (at most 8000 bytes each, whole characters) cannot be exceeded by CJK or emoji text.
- Per user: at most 20 commands waiting for approval, at most 20 queued or running, the runner's 100 active jobs and 64 KiB payload.
- Boot: the runner sweeps jobs a dead process left `running` (non-resumable kinds become `interrupted`), then the bus appends the missing terminal events (`interrupted`) and expires overdue approvals; the same sweep runs every minute and a read repairs a finished job that lacks a terminal event.
- **Stuck lane (M5).** If the settle of a finished job throws (a database error in `finishJobSystem`), the row would stay `running` and hold its lane for good. The minute sweep therefore marks every `running` row that this process's runner does not hold (`runner.activeIds()`) and that started more than 30 s ago (`sweepStaleMs`) `interrupted`, appends its terminal `interrupted` event and pumps the queue (`kb/job-queue.mjs reapOrphanedRunningSystem`, `executor.sweepOrphans`).
- **Fairness (M5).** The runner has 3 slots and one user may run at most 2 at once (`perUserLimit`, default slots minus one): a user who queues many commands cannot occupy every slot. The oldest queued job of another user is claimed instead (`claimNextJobSystem({ perUserLimit })`).

## 5. Kinds

| Kind | Tier | Available | Notes |
|---|---|---|---|
| `review` | T0 | **yes** | read-only review of a registered project (`focus`: `code`, `doc`, `conflicts`), engine chosen by `engine: { provider, model?, credential? }` |
| `sources.update` | T1 | no | Node has no source registry: connector credentials and lists live in the Mac app (email, Slack) or are sent per request (Box) |
| `issues.from_notes` | T1 | no | the deterministic note action extractor and the tracker allow-list are in the Mac app; Node has only the meeting planner |
| `issues.implement` | T2 | no | no Node worktree runner or write-mode engine; codex and gemini write mode needs a design and a user decision |
| `loop.run` | T1 | no | loop definitions (stages, verify commands, scope) live in the Mac app; Node has only the confined agent step |
| `custom.run` | T1 | no | saved custom tasks live in the Mac app; Node has no store for a `customTaskId` |

**Mac-side mirror (phone approvals).** The Mac host keeps a Swift table, `PhoneApprovalPolicy` (`mac/Sources/LlmIdeMac/Core/Contracts/`), that maps each phone-startable task to its registry kind and tier: `sources.update`, `issues.from_notes` and `loop.run` T1 (so Source update, Sources to issues, Update issues, Loop engineering, Loop Start and Start stage, and Doc Gen run), `issues.implement` T2 (Implement issues and Review & merge, the ship step), and `custom.run` T1 for a read-only custom task, escalated to T2 for any that can write (default T2 when unknown). `PhoneApprovalPolicyTests` parses this registry and fails on any mismatch, so the registry stays the single source of truth. The phone never answers the Mac's dialog; one dialog at a time and the 3-per-5-minutes limit are per Mac, not per task; no answer in 120 s is a denial. A phone cannot run all tasks at once: it names one.

An unavailable kind is registered (it shows in `GET /bus/kinds` with its reason) and answers 501 `KIND_NOT_AVAILABLE`; nothing is stubbed as success. The six kinds replace the Mac's 13 Auto Task cases (audit section 3).

`review` with `conflicts` asks git first (`ls-files -u`, `diff --check`) and makes **no model call** when git finds nothing.

## 6. Engines

Interface (`extension/routes/bus/engines.mjs`): `runTask({ userId, engine: { provider, model?, credential? }, prompt, cwd, mode, signal, spawn, deps }) -> { text, usage?, stopReason, engine }`.

| Engine | Provider names | How | Credential |
|---|---|---|---|
| `claude` | `anthropic` | the Agent SDK confined agent (`runLoopAgent`) with the new `readOnly` option: Edit and Write are neither offered nor allowed; a reported changed path fails the run | the SDK ladder: vault key, then env key, then the operator's `claude login`; `credential: api-key` requires a stored key (`engine_no_key`) |
| `adapter` | `custom:cat-...` | a provider-catalog connection through the multi-provider adapter: **text only, no file access**, so the prompt carries bounded, redacted read-only git evidence | the connection's own key |
| `codex` | `openai` | **DISABLED** (`available:false`, reason `ENGINE_NOT_SANDBOXED`). Code kept: `codex exec -C <cwd> -s read-only` via `cliInvocation` | its own CLI login only (never an API key in the child env) |
| `gemini` | `google` | **DISABLED** (`available:false`, reason `ENGINE_NOT_SANDBOXED`). Code kept: `gemini --prompt=...` via `cliInvocation` | its own CLI login only |

**codex and gemini are disabled for the bus until an OS sandbox exists** (security review M1). Their "read-only" holds only inside the checkout: the child still sees `HOME`, `XDG_*` and `PATH`, the CLI's login files are readable, `codex -s read-only` can still read `~/.ssh` and every other file the user can, and gemini has no sandbox flag at all. So `POST /bus/commands` with a codex or gemini review is refused `501 ENGINE_NOT_SANDBOXED` (nothing is queued), `runTask` refuses them `kind_not_available` without spawning, and `GET /bus/kinds` reports `engines` (only the selectable ids: `claude`, `adapter`) and the additive `engineStatus: [{ id, available, reason? }]` listing every engine. `claude` (the confined agent) and the text-only `adapter` stay available. The seam `deps.allowUnsandboxedCli` is test-only. **Documented gap:** an API key is never put in a CLI child's environment (a key in a process we cannot confine is readable by it), so `credential: api-key` is refused for CLI engines (`kind_not_available`) and, once they are enabled, they run on the CLI's own login only. Result and event text is redacted with `core/redact-secrets.mjs`, which now also covers PEM private key blocks (a truncated block to the end of the text), `ssh-rsa`/`ssh-ed25519`/`ecdsa` key lines, AWS access key ids (`AKIA`, `ASIA`), AWS secret access keys and session tokens, and a long base64 blob after a key-named field.

Rules, each tested:

- `mode` is `read` only; every engine refuses `write` (`kind_not_available`).
- **Never `--yolo`.** The Swift runner passes `--yolo` to codex and `--yolo -p` to gemini, which turns their sandbox off. A CLI argv containing `--yolo` or `--dangerously-*` is refused before spawn, and a model id that reads as a flag is dropped (`cliModelId`). Write kinds on codex and gemini stay `available:false` until a design and a user decision exist (audit G2, T5).
- A CLI child gets `minimalCliEnv`, never an API key and never the server's environment (`LLMIDE_*`, JWT and vault secrets).
- gemini has no read-only flag, so a CLI run on a git checkout must leave `git status --porcelain` unchanged; a changed tree fails the run `read_only_violated`.
- A missing login or key is typed (`engine_not_logged_in`, `engine_no_key`; `engine_no_key` is for `claude` and the adapter), never a silent fallback to another engine.
- CLI children run through the runner's `ctx.spawn`: own process group, killed on cancel, timeout and server quit.
- The project is read in place, not in a throwaway checkout: a worktree per run is a later step (the audit's T0 ceiling asks for it).

## 7. Errors

HTTP errors use the repo envelope `{ error: { code, message, details? } }` with the upper-case form of the bus code (`TIER_DENIED`, `INVALID_ARGS`, `UNKNOWN_KIND`, `UNSUPPORTED_VERSION`, `KIND_NOT_AVAILABLE`, `IDEM_CONFLICT`, `QUOTA_EXCEEDED`, `PAYLOAD_TOO_LARGE`, `APPROVAL_NONCE_INVALID`, `CONFIRM_MISMATCH`, `NOT_PENDING`, `EXPIRED`, `ALREADY_FINISHED`, `TOO_MANY_READERS`, `BUS_DISABLED`, `NOT_FOUND`, `VALIDATION_FAILED`). A terminal `error` event carries the lower-case registry code (`schema/bus/registry.json` `errorCodes`) and a short message, never a stack, path, output or secret. An id that is not the caller's answers 404 `NOT_FOUND`, the same as an unknown id.

## 8. Contract changes in API 100

Additive: nine routes in `ALL_ENDPOINTS`, migration 0058, `SERVER_API_VERSION` 99 to 100, `x-llmide-client` and `x-llmide-host-nonce` request headers (advisory, capped), `LLMIDE_BUS=off`. Two additive library hooks (`enqueueJob({ id })`, `createJobRunner({ onSettled })`) and the `readOnly` option of the Loop agent engine. No existing route, field or status changed.

For the Swift host (S2): to be the desktop class it must (1) generate a per-launch random 32-byte key and pass it hex-encoded to the core it spawns as `LLMIDE_HOST_APPROVAL_KEY` (and to nothing else), (2) compute `proof = hex(HMAC-SHA256(key_bytes, "bus-host-proof/v1"))` itself (CryptoKit `HMAC<SHA256>`), and (3) send it as `x-llmide-host-nonce` together with `x-llmide-client` per forwarded client, only to that spawned core. Sending the old `LLMIDE_CORE_NONCE` value no longer proves anything: without the derived proof every approval stays pending. (Change after the security review: H1.)

Tests: `extension/tests/command-bus.test.mjs` (tenancy, tier refusals, approvals, idempotency, replay, cancel, quotas, kill switch, crash recovery, execution-time re-check, the engines with fake and stub CLIs), `extension/tests/loop-agent.test.mjs` (`readOnly`), `extension/tests/http-contract-live.test.mjs` (the replayable fixtures against a real server), `scripts/conformance-bus.mjs`.
