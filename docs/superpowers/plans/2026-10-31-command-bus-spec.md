# Command bus: one command and result contract for every client

Status: **spec, no code.** Date: 2026-10-31, at `main`. Method: read-only reading of code and docs (`ios_app/**`, `mac/Sources/LlmIdeMac/Features/MobileControl/**`, `docs/mobile/*`, `extension/routes/agent-v2.mjs`, the relay design and its security review, the Auto Tasks audit, `docs/spec/job-runner.md`). Nothing was run, no user data was read, no model was called. Every `file:line` below was read on this date. Numbers say how they were counted.

Parents: [relay design](2026-10-31-relay-design.md), [relay security review](2026-10-31-relay-security-review.md), [Auto Tasks audit](2026-10-31-auto-tasks-audit.md), [extension storage audit](2026-10-31-extension-storage-audit.md), [Phase 5 macOS plan](2026-10-31-tauri-phase5-macos-plan.md) section 9, [sync-kit map](../../kits/sync-kit.md), [automation-kit](../../kits/automation-kit.md), [job-runner spec](../../spec/job-runner.md), [MASTER-PLAN](../MASTER-PLAN.md) S3.

## 0. The user's decision (verbatim) and what it means

> "for any task we do, we command the desktop app and use the return to return to the extension and mobile app; for chat we can use the provider in the mobile app (i.e. the desktop's providers); the code and documents used in the mobile app are not good, so we command the desktop app and do the process there; if you have a better idea I want to implement"

> "do the best, SECURE, usable for BIG projects"

Also standing: Auto Tasks exist so tasks are easy to command from the mobile app; Codex, Gemini and others are used (multi-engine, CLI-login **and** API-key paths).

Reading of it, in one rule: **every client is a remote control plus a renderer. The desktop core is the only place where an engine runs, a key is read, a file is touched or a decision is made.** A client sends a typed command; the desktop returns typed events; the client draws them.

**The better idea (offered as asked, section 9 Q1 decides it).** The rule above is right but today the "desktop" is two processes: a Swift app that owns `:3006` and a Node server on `:3456` that owns engines, replay and the job runner. The best end state is **one command executor in the Node core**, with the Mac app (and the Tauri app later) reduced to a *transport host* (pairing, Bonjour, PIN/token, approval UI, the "Phone access" switches). Then the extension, the phone over WebSocket, the phone over relay, and the future PWA all hit the same executor and the same tier checks, and a Swift rewrite of chat/explorer/auto-task logic is never needed again. The Swift bridges become thin adapters during the migration (S2) and disappear as the core takes each kind (S3). An optional **always-on headless core** (section 9 Q5) makes "desktop off" a non-problem for read commands but is a separate security decision.

## 1. The envelope

One JSON object per frame, UTF-8, same shape on every transport (section 6). Field names are final for S1; types are in `schema/` as JSON Schema (S1 deliverable).

### 1.1 Command envelope (client to desktop)

| Field | Type | Rule |
|---|---|---|
| `v` | int | contract version, starts at 1; additive fields never bump it; an unknown `v` is refused with `unsupported_version` |
| `id` | string, 26 chars (ULID) | client-generated, unique per user; the **command id** that every result event carries |
| `kind` | string | dotted name from the closed registry in section 2 (`chat.start`, `task.enqueue`, ...); unknown kind is refused `unknown_kind`, never ignored |
| `args` | object | **typed per kind** by a JSON Schema in the registry; `additionalProperties:false`; unknown or extra field is `invalid_args`. Args carry **ids and enums, never a filesystem path, a shell command or a provider key**. Free text exists only where the kind says so (a chat message, a search query), is length-capped per kind and treated as untrusted |
| `origin` | object | `{ clientId, clientKind, tier }`. `clientKind` in `desktop-ui`, `extension`, `ios-native`, `phone-pwa`, `relay-bridge`. `tier` is the **client's assurance tier** (section 1.4). **Set by the transport host from the authenticated session, never trusted from the frame**: a field in the frame is overwritten, and a mismatch is logged |
| `idem` | string (<= 64) | idempotency key; the same `(userId, deviceId, kind, idem)` within the retention window returns the original result, never a second execution. Required for every kind that is not read-only |
| `createdAt` | int, ms | client clock, advisory only |
| `ttlMs` | int | how long the desktop may still start this command after receipt (default 60 s live, up to 24 h for queued kinds; the **receiver enforces its own maximum**, relay design M2). A command past its ttl is answered `expired`, never run |
| `userId`, `deviceId` | string | filled by the host from the session (token), checked against the paired-device registry; a frame claiming another user's id is dropped |

A command that arrives over a transport that cannot prove `origin` (an unauthenticated socket) is never parsed past `v` and `id`.

### 1.2 Result and event envelope (desktop to client)

| Field | Type | Rule |
|---|---|---|
| `v` | int | as above |
| `cmd` | string | the command id this event belongs to |
| `seq` | int, from 1 | **per command**, gap-free, monotonic. The reader detects a gap by `seq` and re-attaches (section 1.3) |
| `type` | string | `accepted`, `progress`, `chunk`, `data`, `needs_approval`, `needs_answer`, `ended`, `error`; a chat command also relays the existing `agent-v2` event types verbatim inside `data` (section 1.3) |
| `payload` | object | typed per `(kind, type)` by schema; redacted by the core before it leaves (secret scan, `PhoneRedaction` rules move into the core) |
| `terminal` | bool | **exactly one** event per command has `terminal:true` (`ended` or `error`); after it nothing more is sent for that `cmd` |
| `at` | int, ms | desktop clock, advisory |

Error events carry a **fixed code** (`invalid_args`, `unknown_kind`, `tier_denied`, `switch_off`, `needs_desktop_approval`, `expired`, `duplicate`, `engine_not_logged_in`, `engine_no_key`, `rate_limited`, `desktop_busy`, `not_found`, `internal`) plus a short human text. No stack, path or secret ever appears in an error.

Every command receives an `accepted` (or a terminal `error`) within 2 s; a client that does not see one retries the **same** `id` and `idem` (safe by 1.1).

### 1.3 Ordering and replay (reusing what exists)

The core already has the right primitives; the contract reuses them instead of inventing a second replay system.

| Need | Existing mechanism | In the envelope |
|---|---|---|
| Re-attach to a running chat turn after the client dropped | `GET /agent/v2/turns` (list the caller's running turns) and `GET /agent/v2/turns/stream?sessionId=&after=N` (SSE, `id: <seq>` per frame, `replay_info {gap, dropped, ended}` first when the ring dropped events, 404 `NO_TURN`, 429 `TOO_MANY_READERS`; `extension/routes/agent-v2.mjs:316-326,869-905`) | `chat.attach {sessionId, after}`; the bus relays the SSE frames as events with `seq = SSE id`. `replay_info` becomes event `type:"replay_info"`; a `gap:true` makes the renderer show a gap marker and refetch history |
| Keep a turn alive when the client drops | `detach: true` on `POST /agent/v2/stream` (turn runs on when its own stream drops; `agent-v2.mjs:597-614`) | the bus **always** sets `detach:true` for a non-desktop origin (a phone that loses Wi-Fi must not kill the turn) |
| Stop | `POST /agent/v2/cancel` | `chat.stop` (idempotent) |
| Answer an approval or a question | `POST /agent/v2/decision` | `chat.answer`, `chat.approve` |
| Per-chat provider and model pick | `GET`/`PUT /agent/v2/session/route` (+ `/route/history`) | `chat.route.get`, `chat.route.set` |
| History | `GET /kb/chat/sessions/:id?beforeSeq` (paged, `hasMore`) | `chat.history {sessionId, beforeSeq?, limit}` (read-only) |

Rules that follow:

1. **Per command, `seq` gap-free.** For chat, `seq` is the replay ring's own counter, so a client that holds `after=seq` can resume exactly. The ring is **memory-only, bounded, 60 s after end** (`turn-replay.mjs`); beyond it the client calls `chat.history`, which is durable. This is stated to the user in the UI ("history reloaded"), never hidden.
2. **Tasks use the job store.** A task command's events are **derived from the persisted `jobs` row** (`docs/spec/job-runner.md`: state machine, step labels, result): `task.status`/`task.result` are the durable replay; the live `progress` events are an optimisation. A client that missed everything calls `task.status` and loses nothing. This is what makes "desktop restarted mid-task" survivable.
3. **At-least-once delivery, exactly-once execution.** Events may be delivered twice (re-attach); the client dedupes on `(cmd, seq)`. Execution is once per `idem`.
4. **One reader per command by default, bounded followers.** See section 4.
5. **Terminal event is final.** After `terminal:true` the desktop forgets the live state but keeps the durable record (job row, chat history).
6. **Order across commands is not guaranteed**; commands needing order are expressed as one command (e.g. `chat.start` with its mode, never `set mode` then `send`).

### 1.4 Capability tiers and the permission model

Tiers come from the relay security review (D1, D2) and the Auto Tasks audit (T0, T1, T2). They are **properties of the kind**, checked by the **desktop executor**, never by the client.

| Tier | Meaning | Examples | Gate |
|---|---|---|---|
| **R read-only** | reads data the user already has on the desktop; no write, no spend beyond a chat quota, no shell, no network fetch on the phone's behalf | list/status/history/search/read note/catalogue, `task.status` | allowed for a paired client whose **Phone access** switch for the area is on |
| **C chat** | starts or continues a model turn under the **fixed remote-safe ceiling** (read and search tools, no shell, no write, no `desktop.*`, never inherits Bypass or the desktop's Accept Edits mode); spends the user's quota | `chat.start`, `chat.queue` | switch `chat` on; ceiling is fixed by the kind, not by the desktop mode (D2) |
| **T0** | an auto-task kind with a read-only ceiling on a throwaway checkout | `task.enqueue` of `review` | native client only (D1: never the PWA); switch `tasks` on |
| **T1 desktop approval** | the client only **enqueues**; the job sits `awaiting_approval` until the user approves **on the desktop**; the desktop **re-checks permission at execution time** | `sources.update`, `issues.from_notes`, `loop.run`, `custom.run`, phone-originated `chat` that wants an edit or a tool | desktop click every time |
| **T2 desktop approval plus per-run confirm** | writes code or leaves the machine | `issues.implement`, its `ship` step | desktop click showing the exact ids/branches; never from a queued remote request without the click; never inherits Bypass |
| **D desktop-only** | never remotely | templates, task config, schedules, allow-lists, model routing defaults, provider keys and connections, vault, extension install, Phone access switches, pairing | refused for any `origin` other than `desktop-ui`: `tier_denied` |

**Client assurance tier** (the `origin.tier` value) comes from the client kind: `desktop-ui` = D-capable; `ios-native` = may send R, C, T0 and enqueue T1/T2; `extension` = R plus meeting upload plus chat as itself on the Mac-managed server (section 5); `phone-pwa` = **R and queued low-risk C only, never T0/T1/T2 start, never approvals** (D1, C1 of the review: keys that can write or approve never live in a web client); `relay-bridge` is not a client but the transport adapter and carries the real client's tier.

**Re-check at execution time (mandatory).** A command is checked three times: at **receipt** (schema, tier of the origin vs the kind, switch on, ttl, idem), at **approval** (the desktop UI shows the typed args, not a client-written summary), and at **execution** (the user is still signed in, the switch is still on, the device is not revoked, the project is still the one named, the kind is still enabled; any change is a terminal `error` with `switch_off`/`tier_denied`, never a silent run). This closes the Auto Tasks finding that a phone run ignored the task's enable flag (F4): **the enable flag is part of the execution-time check**; a phone `task.enqueue` of a disabled task is `needs_desktop_approval`, which says so on screen.

**Per-user isolation.** Every row (jobs, idempotency records, replay buffers, followers) carries `user_id`; the executor takes `userId` from the **session**, not the frame; a command naming another user's session or job id returns `not_found` (the same shape as an unknown id, so ids are not an oracle). This is the existing rule (`KB helpers take userId first`) extended to the bus.

**Resource limits (BIG projects).** Per-device rate limit and in-flight cap (default 4 concurrent commands, 1 running turn per chat session, 2 per user); per-kind result size cap with **paging** (`cursor`, `limit` <= 200 rows, 256 KiB per event); `chat.history` and file/note listings are **paged and bounded by design** so a 100,000-file project or a 5,000-message chat never produces one giant frame. The core already pages history (`beforeSeq`/`hasMore`) and bounds the mention index; the bus forbids the unbounded variants (the existing `explore_search_files` and `files_list` become paged kinds).

## 2. The command catalogue

Convention: **who** = clients that may send it (D desktop-ui, X extension, N ios-native, P phone-pwa). Every row is **typed args** (schema in S1); free text is marked. "switch" = the Phone access switch that must be on (`PhoneAccess`, `PhoneAccessSettings.swift:17-27`).

### 2.1 Chat

| Kind | Args | Tier | Who | Notes |
|---|---|---|---|---|
| `chat.start` | `{ sessionId?, text(free, <=32 KiB), mode: "ask"\|"plan", attachments?: [noteId\|fileRef], route?: {provider, model} }` | C | D X N, P (queued, ask only) | `mode` never `execute` from a remote origin; an edit-wanting turn becomes `needs_approval` under T1. Returns the session id and `seq` stream. No `history` arg: the core owns history |
| `chat.queue` | same as `chat.start` plus `ttlMs` | C | N, P | for a desktop that is off or busy; queued at the executor or the relay inbox; runs only when the desktop executes it, under the fixed ceiling |
| `chat.stop` | `{ sessionId }` | C (always allowed) | D X N P | idempotent |
| `chat.approve` | `{ sessionId, requestId, decision: "allow_once"\|"deny" }` | T1 | D, N (switch `toolApprovals`) | **never P**; never "always allow" from a remote origin (a project-scoped prefix rule is a desktop-only decision) |
| `chat.answer` | `{ sessionId, requestId, answers: [{questionIndex, labels[]}] }` | C | D X N | answers the agent's own question; carries labels, not free prompts; request id must be currently open for this user |
| `chat.attach` | `{ sessionId, after }` | R | D X N P | re-attach, section 1.3 |
| `chat.sessions` | `{ scope: "quick"\|"explorer", cursor?, limit }` | R | D X N P | list |
| `chat.history` | `{ sessionId, beforeSeq?, limit }` | R | D X N P | paged |
| `chat.session.manage` | `{ sessionId, op: "rename"\|"new", title? }` | C | D N | delete and clear stay **D** (today `chatDeletionSwitch`, `MobileControlManager.swift:318`; keep it desktop-only) |
| `chat.route.get` / `chat.route.set` | `{ sessionId }` / `{ sessionId, provider, model }` | R / C | D X N P(get only) | names only, section 3 |
| `chat.options` | `{}` | R | all | the picker data: providers that are **usable now** (connected, logged in), their models with capability flags and per-model caps, never keys or endpoints (section 3) |

### 2.2 Tasks (the six job kinds from the Auto Tasks audit)

| Kind | Args | Tier | Who | Notes |
|---|---|---|---|---|
| `task.enqueue` | `{ taskKind: "review"\|"sources.update"\|"issues.from_notes"\|"issues.implement"\|"loop.run"\|"custom.run", params }` | by `taskKind` | see below | `params` typed per task kind: `review {focus: "code"\|"doc"\|"conflicts", projectId}`; `sources.update {sourceIds?[]}`; `issues.from_notes {projectId, since?}`; `issues.implement {projectId, issueIds[], ship?: bool}`; `loop.run {projectId, loopId, stageId?}`; `custom.run {customTaskId}`. **No path, no command, no prompt text**; a free prompt exists only inside a saved custom task made on the desktop |
| `task.list` | `{ cursor?, limit, state? }` | R | D X N P | per-user, newest first |
| `task.status` | `{ jobId }` | R | D X N P | state, step label, counts, last error code |
| `task.result` | `{ jobId, cursor? }` | R | D X N P | bounded, redacted, paged |
| `task.cancel` | `{ jobId }` | always allowed | D N (X) | idempotent; queued becomes cancelled, running aborts the process group |
| `task.kinds` | `{}` | R | all | the registry with each kind's tier, args schema, enabled flag and whether it needs approval right now |
| `task.approve` | `{ jobId, confirm: {issueIds?/branches?} }` | T1/T2 | **D only** | the desktop approves; never remotely |

`task.enqueue` tiers: `review` = T0 (N only; D yes; not P, not X); `sources.update`, `issues.from_notes`, `loop.run`, `custom.run` = T1; `issues.implement` and `ship` = T2. Read the registry from `task.kinds`, never hard-code it in a client.

Tasks **not** in the bus (REMOVE in the audit): generateKnowledge, generateDoc, updatePlanStatus. The phone's old message ids alias to the new kinds for one release (S2/S4). Never phone-editable: templates, config, schedules, toggles (D), turned into the requirement R-T3 in section 6.

### 2.3 Library, explorer-read, status, extensions

| Kind | Args | Tier | Who | Decision |
|---|---|---|---|---|
| `library.search` | `{ query(free, <=500), cursor?, limit<=50, scope? }` | R | D X N P | FTS5 hits hydrated per user; snippets redacted |
| `library.read` | `{ noteId }` | R | D X N P | by **id**, never path; text capped 256 KiB, paged; secrets/keys stripped by the core's redaction |
| `library.note.create` | `{ title, body(free, <=64 KiB), folderId? }` | **T1** | D N | **Decision: allowed only as an enqueued request approved on the desktop, native client only**, because a note is data that later feeds prompts (injection vector); never P. This is the "phone shares a link or a thought into the Library" case |
| `library.sources` | `{}` | R | D X N | connector status (counts, last run), never credentials |
| `explorer.list` | `{ projectId, dirId?, cursor?, limit<=200 }` | R | D N (switch `fileBrowse`) | **Decision: read-only, id-based, native only, off by default (as today), never P and never X.** Directory ids come from the desktop's own listing; no path ever travels. Honors the same secret/`.git`/symlink rules as `PhoneFiles` (`PhoneAccessSettings.swift:59`) |
| `explorer.read` | `{ projectId, fileId, cursor? }` | R | D N (switch `fileBrowse`) | text only, capped, redacted, paged. Writing a file from the phone does not exist |
| `project.list` / `project.switch` | `{}` / `{ projectId }` | R / C | D N, P (list) | switch is refused while a task runs (today's rule, `PhoneAccessSettings.swift:58`) |
| `status.get` | `{}` | R | all | the `/health` projection: engines logged in or not (boolean), running turns/jobs counts, version, API version, enabled features. **Never** a key, a path or a token. Doubles as the transport liveness probe |
| `usage.get` | `{}` | R | D N P | per-model meters and subscription windows (read) |
| `activity.list` / `activity.seen` | `{cursor?}` / `{ids[]}` | R / R | D X N P | the activity feed |
| `extensions.catalog` | `{ kind?: plugins\|mcp\|llm-sources\|skills }` | R | D X N P | the read-only catalogue from the [extensions-catalog plan](2026-10-31-extensions-catalog.md): names, versions, enabled. **Install, update, enable, remove and hook consent are D** |
| `generation.run` | `{ templateId, projectId }` | T1 | D N | Doc Gen from the phone writes files: stays an enqueued request approved on the desktop (today a default-OFF switch `generationRun`) |
| `selfheal.*`, `scm.*`, `issues.*` | existing read kinds plus `issue.comment` | R, `issue.comment` T1 | D N | mapped 1:1 from today's messages in S2; `selfheal.apply` stays D (today a phone switch, default OFF; **recommendation: make it D**, it patches the source checkout) |

Never in the bus for any non-desktop client: file write, shell, any `desktop.*` control tool (Phase 7 design 5.4), provider key or connection edits, vault, user/device administration, backup/restore, Auto Task config, extension install, Phone access switches.

## 3. Provider and engine routing

**The phone sends names. The desktop routes.** `route` is `{provider, model}` where both are **opaque names from `chat.options`**, validated server-side against the same catalogue the desktop UI uses. A name not in the catalogue is `invalid_args`; a catalogue entry that is not usable now (not logged in, no key, over its cap) is `engine_not_logged_in` / `engine_no_key` / `rate_limited`, shown as text, **never a silent fallback to Claude** (the repo's standing rule).

Engine ladder on the desktop, unchanged by this spec and reused by every origin:

| Engine | Path | Credential | Notes |
|---|---|---|---|
| Claude Agent SDK | `extension/llm_agent/sdk/` | the user's `claude login` **or** the stored per-user key | default; the confined SDK agent; replay ring and `detach` apply |
| Provider adapter | `extension/providers/` (Vercel AI SDK; **tools opt-in per provider**) | per-user vault key or provider connection (`/kb/providers/catalog`) | OpenAI-compatible and others; tools only where enabled |
| `codex` CLI | CLI spawn layer | the CLI's own login **or** an API key in the vault | Auto Task writes today use `--yolo` (Auto Tasks audit F6, F9): in the bus a remote origin never gets write mode; read mode is `-s read-only` |
| `gemini` CLI | CLI spawn layer | CLI login **or** API key | same rule |

Both credential paths stay first-class (user decision): the engine record is `{provider, credential: "cli-login"|"api-key"}`, resolved on the desktop. A missing login is the typed error above.

**What a phone may change:** pick a model for **this chat** (`chat.route.set`, tier C, only from the catalogue; the core already refuses a route change while a turn is in flight, `handleRoutePut(..., {isChatTurnInFlight})`); pick `mode` ask/plan; choose attachments by id. **What it may not:** add, edit or remove a provider connection, read or write any key, change the per-tier defaults, the Auto Task engine, the token cap, the model allow-lists, or enable `--yolo`. Those are D.

**Keys and logins never leave the desktop:** no kind returns one; no event payload carries one; the secret scanner runs on every outbound payload (the existing guardrails); `chat.options` returns booleans (`usable`, `reason`) and names, never `baseURL` of a private endpoint. A phone cannot even learn **which** key is used, only the provider name.

**Provider logic on the phone is deleted** (section 7): the phone does not know provider quirks, retries, fallbacks, token caps or model ids beyond display strings.

## 4. Results routing

1. **Events go only to the originating client** (`origin.clientId`, the connection that sent the command or its re-attach).
2. **Follow.** The same user's *other* clients may **follow** a command by sending `follow {cmd}` (R); the executor checks `userId` equality and that the follower's tier may read that kind. A follower receives events from `seq` it asks for, with the same replay rule; it can never send `chat.approve`/`chat.answer` for a command it does not own unless its own tier allows it (an iPhone that follows the desktop's turn may answer a question; a PWA may not). Followers are bounded (the replay ring's reader cap is the existing `TOO_MANY_READERS`).
3. **Never broadcast.** No event is published to "all clients"; the activity feed is the only fan-out, and it is a read of a per-user table, not an event stream.
4. **Task results** are pulled from the durable job row; a push (section 8) only says "something changed".

**The extension.** Today the Chrome extension is a live client of the **Mac-managed** server (`127.0.0.1:3456`), keeps only an unfinished capture draft, and clears it when the server reports the capture acked by the Mac app (`extension/CLAUDE.md:17`, env `LLMIDE_LIVE_ACK=1`, `extension/.env.example:152`). That relationship is kept, and the bus reconciles with it as follows:

- The extension is `clientKind: extension`, tier = R plus **meeting upload** (`POST /kb/live/...`, unchanged) plus `chat.*` and `task.status` as **itself on the user's own Mac-managed server** (same user, loopback, JWT as today). It reaches the bus through the same HTTP/SSE routes the desktop UI uses (section 6.3), not through `:3006`.
- **One-copy rule** (data-lifecycle rule 1: each kind of data has one durable home): the bus adds **no durable copy**. The command record is an idempotency stub (id, kind, hash of args, state, no payload) kept for the retention window; chat history stays in the chat session store, task results in the jobs row and `system/`, notes in the notes folder. The extension never stores a result; it renders the event and may cache nothing beyond its capture draft. `LLMIDE_LIVE_ACK` keeps its meaning: the **capture** is the only extension-held data and it is removed only after the desktop acks it. A queued relay inbox request (relay design section 3) is the one place data exists only outside the desktop, TTL-bound, and its loss is a dropped request.
- Extension chat results arrive on the **extension's own** SSE stream (the same events as the phone, section 1.2). It does not receive the phone's, and the phone does not receive the extension's, unless one follows the other under 4.2 with the same user.

## 5. Capability negotiation (so old clients keep working)

Today the Mac sends `Connected.protocolVersion` (2) and `capabilities[]` (`MobileProtocol.swift:20-44`), and a changed switch sends `mac_capabilities`. The bus keeps both: the `hello` reply lists `{ v, kinds: [kind, minV], tiers, limits }`. A client shows only what the desktop serves, and **unknown capability strings are ignored** (strings, not an enum), which is the property that makes additive evolution safe. A client older than the bus (`v` absent) is served by the **legacy mapper** (section 6.2) until the "old path kept one release" gate (S4) closes.

## 6. Transports: the same envelope on every wire

The envelope is transport-agnostic: **a transport moves opaque frames and authenticates a session; it never interprets a kind.**

| Transport | Status | Carries the envelope as | Auth | What the host still does |
|---|---|---|---|---|
| Desktop UI to core | today | HTTP routes `/agent/v2/*`, `/kb/*` and SSE | loopback JWT | UI only; no bus code change needed in S1 |
| Extension to core | today | same HTTP/SSE | loopback JWT | none |
| iPhone to Mac | today | WebSocket `:3006` `ws://`, one JSON text frame per message | PIN once, then per-device token (hash stored; `MobilePairedDeviceStore`) | pairing, throttle, single active client, Phone access switches |
| iPhone/PWA via relay | later (R-phases) | the **same JSON inside the relay's E2E message envelope** (relay design 4.3: ciphertext body, signed clear header with `(epoch, seq)`) | per-device keys and signed requests (relay design 4.4-4.8) | the desktop's relay producer/consumer feeds the same executor |

### 6.1 Mapping to the relay envelope

The relay's header carries `version, purpose, kind id, epoch, seq, senderId, recipientId, requestId, issuedAt, expiresAt, userId, desktopId, deviceId`. The bus envelope fits **inside the ciphertext** without change: `requestId` = bus `id`, `expiresAt` = `createdAt + ttlMs` (advisory; the desktop enforces its own maximum), `kind id` = an opaque per-epoch mapping of `kind`. Two consequences: (a) **the relay never sees `kind`, `args` or `origin`**; (b) tier checks happen **on the desktop after decryption**, so a malicious relay cannot raise a tier. A relay-delivered command's `origin.tier` is taken from the **device record in the desktop-owned registry** (relay design 4.6), never from the frame.

### 6.2 What the Mac app keeps doing

During S2 to S6 the Swift app stays the transport host for `:3006`: Bonjour, PIN pairing, token auth, throttle, the paired-device store, the single-client policy, the Phone access switches, the approval sheet, and the dispatcher that today routes `explore_*`, `auto_task_*`, `loop_*` etc. (`MobileControlManager.handleInbound`, `MobileControlManager.swift:588-640`). Under the flag (S2) it adds a **legacy mapper**: each old message type is mapped to a bus command and each bus event back to the old reply, so an old iOS build keeps working while the executor moves into Node. The Tauri app does not host `:3006` (Phase 5 plan section 9): until the relay reaches parity the Swift app is required for the phone.

### 6.3 Where the executor lives

Target: a Node module `extension/command-bus/` behind new route group "command bus (new)" in `schema/http` (S1 writes the contract, S3 the routes), reusing `kb/job-queue.mjs`, `kb/job-runner.mjs` (library only today, not wired to any route: Auto Tasks audit F8), `routes/agent-v2.mjs` and `routes/turn-replay.mjs`. The WebSocket host (Swift today, Tauri/Node or relay later) calls `POST /bus/command` and reads `GET /bus/events?cmd=&after=` (SSE); both are loopback-only and carry the host's session as `origin`. Wire change is additive (`SERVER_API_VERSION` bump with the endpoint list, per CLAUDE.md).

## 7. Audit of the mobile app against this spec

Counts (taken with `find`/`cat | wc -l` on 2026-10-31, excluding `.build`): `ios_app/MyApp` 10,681 Swift lines (Services 4,089, Views/Control 4,529, Views/Shared 713, Auth 380, Settings 230); `SharedProtocol/Sources` 2,168 lines in 20 files, 112 message tags (`MobileProtocol.Tag`); iOS tests: **0 in the app** (no test target found), SharedProtocol tests 768 lines in 5 files; Mac mobile tests: 30 files under `mac/Tests/LlmIdeMacTests` named `Mobile*`/`Phone*`/`Pairing*`.

### 7.1 Worst problems (ranked)

1. **Cleartext transport, ATS fully open.** The Mac listens with `NWParameters(tls: nil)` (`MobileWebSocketServer.swift:163`), the phone uses `ws://` and ships `NSAllowsArbitraryLoads = true` (`ios_app/MyApp/Supporting/Info.plist:56`), so the PIN and the long-lived token cross the LAN or Tailscale in the clear and any app on the phone's network position can use them. The plist itself calls the real fix "TLS with an SPKI hash carried in the QR". **Requirement R-SEC-1** (S6, and an earlier interim fix in S2 if you agree, Q2): TLS with a self-generated key whose SPKI hash rides in the pairing QR and is pinned by the phone, or the relay's E2E layer; then remove `NSAllowsArbitraryLoads`.
2. **A phone run ignores the task's own enable flag and can start code-writing and pushing tasks**, gated only by one desktop switch that defaults off (`AutoCodeUpdateService.swift:276-289`; `MobileAutoTaskBridge.swift:117-175,407-409`; Auto Tasks audit F4). **R-T1**: the enable flag is part of the execution-time check; `issues.implement` and `ship` are T2 (desktop click with exact ids), never a direct phone start.
3. **The phone can edit what a later run executes**: `auto_task_template_save/rename/delete`, `auto_task_config_set`, `auto_task_toggle` when `autoTaskControl` is on (`MobileAutoTaskBridge.swift:283-400`, F5). **R-T3**: tier D; the phone keeps read access. The switch's own description ("run, enable, edit settings and templates", `PhoneAccessSettings.swift:55`) is the spec for what to remove.
4. **One switch gates a bundle of unlike powers** (`autoTaskControl`, `loopControl`): run, toggle, config and template edit are one boolean. **R-T4**: tiers per kind, section 1.4; the switch becomes "allow the phone to **request** tasks".
5. **Client-held chat state and a dead history field.** The phone builds `history: [ChatTurn]` from its own transcript and sends it with every `llmide_chat` (`LlmIdeChatMessages.swift:30-40`, `LlmIdeChatStore.swift` `mintStreamingTurn`), but the Mac never reads `chat.history` (only `chat.text` and `chat.files` are used, `MobileControlManager.swift:1008,1128`): the core's session store is the truth. The field is dead weight on every frame and a place where phone state could contradict the desktop. Delete (R-C1).
6. **Provider-ish logic and timeouts on the phone.** `LlmIdeChatStore` runs its own stream idle timeout that sends `Cancel`, with a sticky "approval pause" window to avoid killing a turn the user just approved (`LlmIdeChatStore.swift:36-48`). That is retry/cancel policy the core's replay and detach already own. Replace with `chat.attach` plus a transport heartbeat (R-C2).
7. **Images are accepted by the protocol and refused by the Mac.** `LlmIdeChat.images` exists; `handleChat` answers "Images aren't supported" (`MobileControlManager.swift:952-961`). A wire field that always fails. Delete or implement through `chat.start.attachments` (Q4).
8. **Docs contradict the code in six places** (7.5).
9. **No iOS-side tests and 15 of 20 protocol files have no round-trip test.** Tested: Approval, Connection, Generation, Loop, MobileProtocol. Untested: AutoTask, AutoTaskSetup, Explorer, ExploreSkill, ExploreWorkspace, Files, Issues, LlmIdeChat, MacStatus, Project, SelfHeal, SourceControl, ToolApproval, Usage, Activity. No schema fixtures exist for the phone wire (the HTTP side has `schema/http/fixtures`).
10. **Single-client policy plus no replay on the WebSocket**: a second phone displaces the first (`code:"replaced"`) and a dropped socket loses the live stream with no `after=` resume, though the core has the replay ring. The phone cannot show a long turn across a lock screen.
11. **`DemoMode.swift` is 592 lines** of canned replies spliced into the real stores. Good for App Review (APP_REVIEW_NOTES), but it is the largest single file and it will track every protocol change. Keep; regenerate from the conformance fixtures (S1) instead of hand-written frames.

### 7.2 KEEP / REPLACE / DELETE table

Effort: S under 1 day, M 1-3 days, L 3-8 days, XL over 8 days (one engineer, rough, not measured).

| Area | Paths | Verdict | Why | Effort |
|---|---|---|---|---|
| SwiftUI views, design system, markdown rendering, theme | `MyApp/Views/**` (except noted), `Theme/`, `ChatMarkdown`, `ChatBubble`, `ToolApprovalCard`, `ApprovalQuestionCard`, `StatusBanner` | **KEEP** (renderers) | pure rendering; point at the envelope store | M (rebinding) |
| QR scan, discovery, Keychain token storage, speech input | `QRScannerView`, `DeviceDiscovery`, `ConnectionStore`, `SpeechRecognizer` | **KEEP** | device-specific, no desktop logic | S |
| Connection layer | `ConnectionService.swift` (759) | **REPLACE** with a thin `CommandClient` (send envelope, receive events, dedupe on `(cmd, seq)`, reconnect, re-attach) | owns pairing, reconnect backoff and frame routing by string type | L |
| Chat state | `LlmIdeChatStore` (338), the chat half of `ExplorerChatStore` (543) | **REPLACE** with one `ChatRenderer` over `chat.*` events | duplicates the desktop's session state, timeouts and history building | L |
| Explorer, Auto Task, Loop, Generation, Usage, Activity, Files, Issues, SCM, SelfHeal, Projects, MacStatus stores | `Services/*Store.swift` (about 2,900 lines in total) | **REPLACE** each with a view model that renders `task.*`, `library.*`, `explorer.*`, `status.*` events | per-message-type stores mirror Mac internals (`AutoTaskStore` 442 lines of Auto Task settings and template logic) | XL (staged S4) |
| Auto Task setup and template editor UI | `AutoTaskSetupView`, `AutoTaskTemplateEditorView`, `auto_task_template_*` use | **DELETE** from the phone (read-only view stays) | R-T3: editing is tier D | S |
| `history` field and image attachments in `LlmIdeChat` | `LlmIdeChatMessages.swift`, `ChatInputBar` image path | **DELETE** (history), **DELETE or REPLACE** (images, Q4) | R-C1, finding 7 | S |
| Demo mode | `DemoMode.swift` (592) | **KEEP**, regenerate from fixtures | App Review needs it | M |
| Wire types, per message | `SharedProtocol/Sources/**` 20 files | **KEEP** during the transition behind the legacy mapper; **DELETE** per file as its kind moves to the bus (S4); add `Envelope.swift` (new) | additive; version rule below | M plus per-kind |
| `explore_search_files`, `files_list` unbounded variants | `ExploreWorkspaceMessages`, `FilesMessages` | **REPLACE** with paged kinds | BIG projects | M |
| Mac `MobileControlManager.swift` | 1,857 lines | **REPLACE gradually**: transport host stays, logic moves to the core | one file mixes transport, dispatch, chat proxy and explorer | XL |
| Pairing, PIN, throttle, paired-device store, Bonjour | `MobilePin`, `PairingThrottle`, `MobilePairedDeviceStore`, `MobileBonjourAdvertiser` | **KEEP** (transport host), add TLS pin | well tested (PairingThrottle, PairedDevice*, PinValidation tests) | M (TLS) |
| Phone Access switches | `PhoneAccessSettings` | **KEEP**, re-map to areas (`chat`, `tasks`, `files`, ...) | good model; keep "advertise only while on and re-check every request" | S |
| Redaction, log policy | `PhoneRedaction`, `MobileLogPolicy` | **KEEP**, move redaction to the core for the bus | rules are right | M |
| Verification script | `scripts/mobile/verify-native-pairing.swift` | **KEEP**, add a bus conformance run | | S |
| Docs | `docs/mobile/*` | **REWRITE** (7.5) | contradictions | M |

Summary counts (16 rows): **KEEP 8** (one is the wire-types row, KEEP now and DELETE per file later), **REPLACE 6** (the docs row is a REWRITE), **DELETE 2**. By code: keep roughly 2,900 lines of views and device glue as is, replace roughly 7,000 lines of stores and connection logic and 1,857 Mac dispatch lines over S3-S4, delete about 300.

### 7.3 Wire types: versioning, obsolete, tier bypasses

- **Versioning today.** `protocolVersion = 2`; additive optional fields never bump; capabilities are strings. Good rule, kept. New rule: the envelope has its own `v` (section 1.1); `protocolVersion` stays for the legacy path and is frozen at 2 once the bus ships.
- **Obsolete or dead:** `LlmIdeChat.history` (dead, finding 5); `LlmIdeChat.images` (refused by the Mac); the `legacy` capability set `[chat, explorer, autoTasks, loop]` (`MobileProtocol.swift:44`) once S4 closes; the "PIN-only pairing without token" path still accepted for old builds (`quick-start.md:62-65`) is a weaker credential, drop it at the end of the S4 window; the `llmide_chat_history_clear` message (chat deletion should be D, today behind the `chatDeletionSwitch`).
- **Messages that bypass or weaken tier checks (to turn into requirements):** (a) `auto_task_run` ignores the enable flag (R-T1); (b) `auto_task_template_*`, `auto_task_config_set`, `auto_task_toggle` edit execution inputs (R-T3); (c) `loop_start`/`loop_start_stage` run edits and verify commands under one boolean and have no approval step (T1); (d) `selfheal_action` apply patches the source checkout under a phone switch (make D); (e) `generation_run` writes files under a switch (T1); (f) `issue_comment_post` posts as the user under a switch (T1, keep); (g) `explore_chat` with `exploreEdit` ON runs with the Mac's Code Assistant permission chip "which can be Auto (no prompts)" (`PhoneAccessSettings.swift:64`): **R-C3**, a remote origin never inherits the desktop chip; the ceiling is fixed (D2); (h) `tool_approval_answer` is a remote approval path under `toolApprovals`; keep for the native client only (T1), never P; (i) `project_switch` while a task is queued: refused during a running task, but not checked at **execution** time for queued work; add to R-T5; (j) there is **no per-message tier table at all**: `handleInbound` routes by type prefix and each bridge decides ad hoc (`MobileControlManager.swift:588-640`). **R-G1**: one table `(kind -> tier, switch, who)` consulted by one gate before any handler.
- **Frame limits:** 8 MiB max message (`MobileWebSocketServer.swift:155`) is generous; the bus caps events at 256 KiB and commands at 64 KiB.

### 7.4 Test coverage and the manual list

- **Mac side: reasonable** (30 mobile test files incl. pairing frame, PIN validation, throttle, paired-device expiry, routing, hardening, per-bridge scope tests, `MobileAutoTaskBridgeScopeTests`).
- **iOS side: none.** `ios-ci.yml` builds the app unsigned and runs `make test-shared-protocol`; there is no unit or UI test of a store, of reconnect, of the demo path against real frames.
- **Protocol side: 5 of 20 files have tests**, and no shared JSON fixtures that both the Swift and Node sides read.
- **`docs/mobile/verification.md`** is a manual list "written, no recorded run" (MASTER-PLAN S3). It covers pairing, heartbeat and chat only. **Missing from the list:** Phone access switches (each default and the denied message), Files, Issues, Source Control, Self-Heal, Usage, Activity, project switch, Loop start/stop/stage, Auto Task run with the task disabled (the F4 case), template edit attempt (R-T3), approval relay, locked-screen and background reconnect, the port fallback (3006 to 3015), a second paired phone, a revoked token reconnect, Tailscale path, a 5,000-message chat and a 100,000-file project. Rewrite as a **recorded run table** (date, build, device, result) with each row mapped to a conformance fixture where one exists (section 10).

### 7.5 Docs quality (`docs/mobile/*` and neighbours)

| # | Where | Problem | Fix |
|---|---|---|---|
| 1 | `docs/mobile/quick-start.md:13`, `:137`; `MASTER-PLAN.md:151` | says Chat is "Mac proxies to `:3456`" / "HTTP to server.mjs for Chat / Explore / Auto". Chat goes through `chatHost` into Chat's shared quick engine (the session store is the history), explorer through the explorer engine pool; only that engine reaches `:3456` (`mobile/CLAUDE.md` "Phone chat reaches Chat only through chatHost", `MobileControlManager.swift:937-940,1719-1721`) | rewrite the Architecture diagram and the Features bullets |
| 2 | `quick-start.md:114-118` ("Port 3006 busy ... Quit whatever holds the port") | contradicts `Features/MobileControl/CLAUDE.md` and `MobileControlPortTests`: if busy the manager binds the next free port up to +9 and the QR/Bonjour advertise it; only "all failed" is an error (`reportMobileBindFailure`) | document the fallback and the "ports 3006 to 3015 all failed" error |
| 3 | `quick-start.md:58` ("Home shows Live ... tap Open Explorer, Open Auto Tasks or Open Loop"), `verification.md:54` ("iOS home shows Chat / Explore / Auto toolbar"), `ios_app/MyApp/Views/Support/HelpView.swift:23` ("tap Chat, Explore, or Auto in the toolbar") | the app is `RootTabView`: Chat, Project (segmented Explorer / Auto Tasks / Loop), Settings (`ProjectView.swift:5`, `ContentView.swift:15`). The words do not match the UI | update to the tab names; fix `HelpView` text |
| 4 | `quick-start.md:9-15` ("What you get": Explore, Auto, Chat) and `verification.md:4-5` | omit Files, Issues, Source Control, Usage, Self-Heal, Activity, Projects, Doc Gen/llm-doc browser, and the **Phone access** switches that gate half of them (`PhoneAccessSettings.swift`) | add a capability table generated from `MobileProtocol.Capability` and `PhoneAccess` |
| 5 | `quick-start.md` and `verification.md` "Security" | say "No cloud dependency" and "PIN in Keychain" but never state that the link is **cleartext `ws://`** and that ATS is fully open (`Info.plist:56`); a reader assumes it is encrypted | add an honest "Transport security" section with the interim risk and the R-SEC-1 plan |
| 6 | `verification.md:57-61` ("Token reconnect, revoke, replace") and `:77-80` ("Reconnect / replace": "Second device replaces first", "Re-pair after force-quit") say the same thing twice and the obsolete "waiting for screen" block appears in both docs (`quick-start.md:81`, `verification.md:64`) plus "Screen Recording" in four places | remote-desktop-era text is noise now | delete the duplicates and the screen-era troubleshooting after one release |
| 7 | `verification.md` heartbeat row: "heartbeat_ack every ~10 s" vs `MobileProtocol.swift:11-14` (client sends every 10 s, drop at 25 s) | ambiguous direction | say who sends what |
| 8 | `MASTER-PLAN.md:151` and `ADR 0018` | call the phone link "chat proxies to `:3456` through the Mac" and "Supersedes cleartext" without the interim plan | link this spec |
| 9 | none | no doc for the pairing **threat model**, the Phone access switch semantics per message, or the wire catalogue; the only reference is the Swift comments | `docs/reference/mobile-wire.md`, generated from the S1 schema |

**Rewrite plan:** (1) quick-start becomes a task-order guide (install, enable, pair, what you can do, what the Mac must be doing), with the architecture figure replaced by the section 6 table; (2) verification becomes the recorded-run table above plus the loopback script; (3) a new generated `mobile-wire` reference replaces prose duplicates of message lists; (4) one "Transport security" page (interim risk and the TLS/relay plan); (5) `docs-check` rule that `docs/mobile/*` names only tabs and capabilities that exist in `MobileProtocol.Capability`. Effort M.

## 8. Migration plan in slices, with exit gates

Freeze note: Swift in S2 and S4 is allowed under the freeze as shared-contract/security work (the user's standing rule); this spec writes none of it.

| Slice | Content | Exit gate |
|---|---|---|
| **S1 contract + fixtures (additive)** | `schema/command-bus/` JSON Schemas: envelope, result event, the kind registry with args schemas and tiers, error codes; **conformance fixtures** (golden JSON for every kind: valid, each invalid-args case, every error code, a replay-with-gap sequence, an idempotent resend, an expired ttl, a tier denial per client kind); a generated TypeScript type module and a Swift `Envelope.swift` target; contract test that both Swift (SharedProtocol) and Node decode every fixture | fixtures decode on both sides; a fixture exists for every row of section 2 and every item in the negative list (section 10); no behaviour change anywhere |
| **S2 Mac maps WS to the envelope behind a flag** | `MobileControlManager` gets one **gate** (R-G1): `(kind -> tier, switch, who)` table consulted before any handler; a legacy mapper turns old message types into bus commands and events back to old replies; flag `mobile.commandBus` default OFF; ttl/idem record in memory; interim fixes decided in Q2 (template/config/toggle become D; enable flag checked) | with the flag ON, an old iOS build passes the existing Mac tests; new tier tests (R-T1, R-T3, R-C3) pass; flag OFF is byte-identical to today |
| **S3 core job API** | routes `POST /bus/command`, `GET /bus/events`, the six job kinds over `kb/job-queue.mjs` + `job-runner.mjs`, T1/T2 approval state `awaiting_approval`, execution-time re-check, `task.*` kinds, engine interface `runTask({provider, model, prompt, cwd, mode, signal, spawn})` with `sdk`, `provider`, `codex`, `gemini` implementations (read mode only for remote origins), `LLMIDE_FEATURES` honours the group; `ALL_ENDPOINTS` and `SERVER_API_VERSION` bumped | every `task.*` kind passes its fixtures against the real core with a **fake engine**; per-user isolation test; boot sweep marks interrupted jobs; Auto Tasks audit T3/T4 answered |
| **S4 iOS rewrite as renderer (SwiftUI)** | `CommandClient` replaces `ConnectionService`; one `ChatRenderer`; per-feature view models over `task.*`/`library.*`/`explorer.*`; template editor removed; **old path kept one release** (legacy mapper still on); demo mode regenerated from fixtures | iOS unit tests for the client (reconnect, re-attach with gap, idem resend, dedupe) pass; manual list from 7.4 run once on device and recorded; the legacy path removal is a **separate later commit** |
| **S5 extension on the envelope** | the extension's chat/task views use `/bus/*` and the replay `chat.attach` instead of private routes; capture draft and `LLMIDE_LIVE_ACK` behaviour unchanged | extension tests pass; the real-meeting checklist in `extension/CLAUDE.md` is rerun; no durable result stored |
| **S6 relay transport** | the relay producer/consumer feeds the same executor with the envelope inside the E2E message; TLS pin on the direct path; R-SEC-1 closed; PWA gets R/queued-C only | relay-blindness test (the relay cannot read `kind`/`args`), G-EXT external review, negative-test list green |

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Desktop off** | direct path: `desktop_off` is a client state with a clear banner, never a hang; queued kinds (`chat.queue`, T1 enqueue) are accepted only where a durable inbox exists (relay, S6) with ttl; before the relay, **nothing is queued on the phone** (no silent replays later) |
| **Long-running tasks** | tasks are durable jobs (restart-safe by the job runner's boot sweep); the client polls `task.status`; a result is pulled, not pushed; caps on turns and tokens stay desktop settings |
| **Mobile background limits** | iOS suspends the socket within seconds: the client **must** treat disconnect as normal and re-attach with `after`; push is a wake-up only (relay design 7.4: generic payload, no kind or title) |
| **Push** | out of scope until S6; direct path has none |
| **Replay of a captured command** | `idem` plus per-device monotonic nonce checked against the registry, `ttlMs` enforced by the receiver; the relay adds signed `(epoch, seq)` |
| **Token theft** | per-device token hashed on the Mac; revoke; **TLS pin (R-SEC-1)** removes sniffing; token bound to the device id; short idle expiry (the store already has expiry tests) |
| **QR/PIN** | PIN one-time and rotating (kept), throttle (kept), QR carries the SPKI pin in S6; a screenshot of the QR is a credential until the PIN rotates, said in the UI |
| **Tier bypass** | single gate (R-G1); tier is a property of the kind; `origin` set by the host; the executor re-checks at execution; contract test: **every kind in the registry has a fixture per client kind** that proves allow or deny |
| **Prompt injection into the executor** | args are typed ids and enums; free text only in chat/search/note-create; ingested content is untrusted (relay design 7.3); a remote origin never gets write or `desktop.*` tools |
| **Two executors (Swift and Node) disagree during S2-S4** | the gate table and the fixtures are shared data; the legacy mapper is tested against fixtures |

### Test plan (no model calls)

A **fake desktop** (a Node harness implementing the executor with a **fake engine** that emits scripted `agent-v2` events, including drops, gaps and stalls) and a **fake phone** (a script that speaks the envelope over a WebSocket and, later, over a fake relay) run the golden fixtures: valid, each invalid-args, each tier denial per client kind, expired ttl, duplicate idem, resend after drop, `after=` replay with and without a gap, 60 s post-end reattach, 429 reader cap, per-user isolation (user B asks for user A's job or session: `not_found`), revoke mid-turn, switch flipped mid-queue (denied at execution), desktop restart mid-job (sweep), 5,000-message paging, 100,000-id listing paging. Zero tokens, runs in CI beside `make test-shared-protocol`. The iOS client gets the same fixtures as unit tests. Negative-test names follow the relay design list (11.1), adding: `phone_cannot_edit_template`, `phone_run_respects_enable_flag`, `pwa_cannot_enqueue_t0`, `remote_origin_never_gets_bypass`, `remote_chat_edit_needs_desktop_approval`, `no_key_in_any_payload` (secret scanner over every fixture result).

## 10. What NOT to do

- **No second engine in the mobile app.** No local model, no on-device prompt building, no provider SDK, no tool loop, no history assembly.
- **No provider keys, tokens or logins on the phone**, not even "cached for convenience"; no endpoint that returns one.
- No path, shell command or free prompt in `args` of any task kind; no remote `execute` mode; no remote inheritance of Bypass or the desktop's permission chip.
- No phone-side retry policy or fallback to another provider; errors are typed text.
- No second durable copy of chat, notes or results in a client or in the bus.
- No broadcast of events; no tier decided by a client.
- No PWA approvals, task starts or write keys (D1).
- Do not move chat, explorer or auto-task logic **into** the iOS app to "make it work offline"; offline is the relay's job.
- Do not remove the legacy path in the same commit that adds the new one.

## 11. Open questions for the user (few, each with a recommendation)

1. **Is one Node command executor the target, with the Mac app as a transport host only (section 0, 6.3)?** Recommendation: **yes**. It is the better idea: one gate, one set of fixtures, the Tauri app and relay inherit it, and Swift stops growing.
2. **Do the interim Swift fixes now, before the flag (S2)?** (a) Make `auto_task_template_*`, `auto_task_config_set`, `auto_task_toggle` desktop-only; (b) check the task's enable flag on a phone run; (c) make `issues.implement` and `reviewMerge` require a desktop click. Also (d) TLS with a pinned key in the QR to close the cleartext link and the open ATS. Recommendation: **yes to (a), (b), (c) now; (d) design now, ship with S2/S6** (it needs an on-device Tailscale test, per the plist note). Behaviour changes, so not done without your word.
3. **May `library.note.create` and `explorer.*` exist for the phone at all?** Recommendation: note create **T1, native only**; explorer read-only, id-based, native only, default off as today.
4. **Images from the phone**: delete the dead field, or implement them as attachments through the core? Recommendation: **delete now**, implement after S4 through `chat.start.attachments` once the engine path supports it.
5. **Always-on headless core** (a small Node process, no UI, on the user's own machine or home server, holding the same state) so the phone works with the desktop app closed? Recommendation: **design it, do not build it yet**; it needs its own threat model (a key store on an unattended machine) and the relay's queued inbox covers "desktop off" for a first version. Decide before S6 whether the relay's executor *is* that core.
6. **Single active phone** (today a second phone displaces the first): keep, or allow two native devices of the same user with `follow`? Recommendation: **allow up to 3 devices per user with one writer at a time**; it removes the replaced-by-your-own-iPad surprise and matches section 4.

## 12. Requirement index (for traceability)

R-G1 one gate table; R-T1 enable flag at execution; R-T3 templates/config/toggle are D; R-T4 per-kind tiers not one boolean; R-T5 execution-time re-check incl. project and switch state; R-C1 no client-held history; R-C2 no phone-side retry/timeout policy; R-C3 fixed remote ceiling, never the desktop chip; R-SEC-1 TLS pin or relay E2E, remove open ATS; R-X1 extension keeps `LLMIDE_LIVE_ACK` semantics and stores no result.
