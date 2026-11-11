# Host API v1 contract

The machine-checked contract for Mac, desktop, iOS and web clients. Design:
[`docs/superpowers/specs/2026-11-03-host-api-design.md`](../../../docs/superpowers/specs/2026-11-03-host-api-design.md).

This directory contains the frame envelope, command registry, event schemas and
fixtures. The host is the core's gateway (`extension/routes/host-api/`), run by the desktop app; Swift validation and payload types are generated into `ios_app/SharedProtocol`.

## Limits

- `apiVersion` is always `1`.
- A frame is at most 1,048,576 bytes.
- Lists default to 100 items, maximum 500.
- A list result is at most `maxListBytes` (786,432 bytes = 768 KiB, measured as UTF-8 JSON of its items), which leaves headroom for the envelope under the frame cap. A host trims a snapshot's message list from the oldest end until it fits; `limit` stays the upper bound on count, so a client gets "the recent N that fit". The newest message is always included, never cut further: its text is already clamped to 100,000 characters, at most ~600 KB even fully escaped, so it always fits the budget alone. No wire field says a list was trimmed.
- `chat.sessions` pages by `offset` (at most 100 per page; `nextOffset` is present while more exist) and is scoped to one project by `projectId` (omitted = the legacy/global, project_id NULL chats). `chat.history` pages backwards by `beforeSeq` (`nextBeforeSeq` is present while older messages exist), takes the same optional `projectId`, and refuses a session whose project differs from it (`denied` with `PROJECT_MISMATCH`). It is trimmed to `maxListBytes` like `chat.snapshot`: oldest dropped first, the newest always kept, with `nextBeforeSeq` pointing at the oldest kept message.
- Error messages are at most 500 characters.
- Payload objects are closed: unknown fields are rejected with `invalid_payload`.
- Schema `pattern`s must end in `$` and avoid `\d`, `\w`, `\s` and `.`: the Swift validator rewrites only a trailing `$` to end-of-input and otherwise uses ICU semantics, which differ from JS for those classes.

## Workflow

1. Add or change the command in `commands.json`.
2. Add both fixtures under `fixtures/commands/<command>.request.json` and
   `.result.json`.
3. Add or change the event in `events.schema.json` and add its fixture under
   `fixtures/events/`.
   To add an invalid fixture, update `fixtures/invalid-cases.json`.
4. Run `node scripts/generate-host-api.mjs`.
5. Run `node scripts/conformance-host-api.mjs`.
6. Run `make host-api-check`.

The conformance gate also composes every command fixture into a request and a
response frame, and scans every schema for unsupported keywords, so a typo such
as `minLenght` fails the gate instead of being silently ignored.

## Commands

All 25 commands are listed below.

| Command | Capability | Idempotent | v2 tag |
|---|---|---|---|
| `host.hello` | host | yes | — |
| `host.auth.pair` | host | no | `pairing` |
| `host.auth.token` | host | yes | — |
| `host.auth.revoke` | host | yes | — |
| `host.ping` | host | yes | `heartbeat` |
| `host.snapshot` | host | yes | — |
| `chat.snapshot` | chat | yes | `llmide_chat_history_list` |
| `chat.send` | chat | no | `llmide_chat` |
| `chat.history.clear` | chat | yes | `llmide_chat_history_clear` |
| `chat.cancel` | chat | yes | `llmide_cancel` |
| `chat.options` | compose | yes | — |
| `chat.new` | compose | no | — |
| `approvals.answer` | approvals | no | `approval_answer` |
| `toolApprovals.answer` | tool_approvals | no | `tool_approval_answer` |
| `chat.sessions` | read | yes | — |
| `chat.history` | read | yes | — |
| `usage.get` | read | yes | `usage_get` |
| `push.config` | push | yes | — |
| `push.register` | push | yes | — |
| `push.unregister` | push | yes | — |
| `tasks.list` | read | yes | — |
| `tasks.run` | compose | no | — |
| `tasks.status` | compose | yes | — |
| `tasks.cancel` | compose | yes | — |
| `projects.list` | host | yes | — |

`read` (tier R in the command bus spec) is the read-only slice: the user's chat list, one chat's history, and the usage and limits summary. It is served only when the host enables it (desktop: `LLMIDE_HOST_API_READ=1`, default off) and only to a device paired while it was served. The Tauri app passes only `LLMIDE_HOST_API_TLS` and `LLMIDE_HOST_API_WEB_ORIGINS` to a core it starts (`desktop/src-tauri/src/core_env.rs` drops every other `LLMIDE_*`), so `read` works only on a core you start yourself (`cd extension && LLMIDE_HOST_API_READ=1 npm run server`), which the app then adopts; it fails closed otherwise. The remaining spec domains (Explorer, Auto Tasks, Loop, projects, files, SCM, issues, Self-Heal, generation, Library, activity) are added by later plans using the same envelope and registry machinery.

`projects.list` returns the paired device's projects and its effective role on each (`id`, `name`, `role`, `maxMode`, `usdCapMonth`, `permissions`). A project-scoped command (`chat.send`, `chat.new`, `chat.snapshot`, `chat.sessions`, `chat.history`, `chat.history.clear`, `chat.cancel`, `chat.options`, `approvals.answer`, `toolApprovals.answer`) may carry `projectId`; the host checks the fresh project grant on every frame, and an unassigned device is a viewer on that project (Ask only). A frame with no `projectId` keeps the legacy/global chat, so existing pairings keep working. One current chat is kept per (user, project): `chat.sessions` without a project is only the project_id NULL set, and `chat.history` refuses another project's session. On a hub every project-scoped frame needs a project (`PROJECT_REQUIRED`).

`compose` is the web chat's turn options: `chat.options` lists the modes a client may pick (read-only ones only: `auto`, which runs `auto_read_only`, `ask`, `plan`, `assist_plan`, `review`, `document`) and the account's Claude models; `chat.send` may then carry `mode` and `model`, which a host honours only for a session granted `compose` (`denied` with a re-pair hint otherwise) and re-checks against the same lists; `chat.new` starts a fresh phone chat in the frame's project, or the legacy/global one when no project is named (the previous one stays readable through `chat.history`). Served only when the host enables it (desktop: `LLMIDE_HOST_API_COMPOSE=1`, default off), never to a relay-bridged session, and only to a device paired while it was served. Bounds are pinned by `fixtures/security/compose.json`. Attachments stay under `chat`: text only, the host frames them as `{ path: name, content: text }` for the model.

## Events

Events are the seven flat variants in `events.schema.json`: `chat.delta`,
`chat.done`, `chat.error`, `approval.request`, `approval.cleared`,
`toolApproval.request` and `host.capabilities`. Each variant is a complete
object schema with its own `payload`; they are not composed with `allOf`.

## Snapshots

`host.snapshot` returns a `snapshots` map. Per-domain snapshot payloads are
opaque in v1; clients should request the typed domain snapshot command for a
concrete shape.

## Ordering

Frame ordering is the envelope `rev` on the frame itself. Every `Response` and
`Event` carries `rev`; an `ErrorFrame` may carry it. Snapshot command results
do not repeat it in `result`.

## Hosts

The desktop host adapter is `extension/routes/host-api/` (gateway, frame codec, session gate, translator) with the listener in `extension/server/host-api-listener.mjs` — plaintext on loopback in development, pinned WSS when TLS is on (off by default). The desktop UI mints the pairing PIN and manages paired devices through `POST /host-api/pin`, `GET /host-api/devices` and `DELETE /host-api/devices/:id` (contract `schema/http/host-api.schema.json`).

The web client is `web/` (`web/src/host-api/connection.ts`), and its types are generated into `web/src/host-api/types.generated.ts` by `scripts/generate-host-api.mjs`.

## Clients

Swift clients build requests with `HostApiFrame.request` and parse host frames with `HostApiFrame.parseInbound`. Event names are the generated `HostApiEvent`. `HostApiV1Client` is the reference client. The iPhone speaks v1 only (its v2 Mac link was removed); it maps the approval events onto its card models with `ApprovalRequest(event:)`, `ToolApprovalRequest(event:)` and `ApprovalCleared(event:)`. The phone pins the host's `h1fp` (`pin_mismatch` / `pin_missing`); see `fixtures/security/`, shared by the Node and Mac tests, for the origin rule and the fingerprint vector.

## Host differences

The desktop (Tauri app with the Node core) is the only host since the Swift Mac app was removed (2026-11-06). These
are the desktop's host-specific rules; a future second host must document its differences here.

- **Gate prose.** Refusal messages say "This computer…"; clients branch on `code` (and `retryable`), never on text.
- **Engine rejections.** A turn refusal whose code the desktop does not know (anything but `TURN_IN_PROGRESS`,
  `SDK_UPDATING`, `PLUGIN_UPDATING`, `ROUTE_UNAVAILABLE`, `SESSION_TOKEN_LIMIT`, `SLASH_COMMAND_FAILED`) becomes a
  `chat.error` with a generic message and `retryable: false`.
- **Snapshot trimming.** `chat.snapshot` / `host.snapshot` messages are trimmed to `maxListBytes` (see Limits): oldest
  dropped first, the newest always kept.
- **Compose.** Only the desktop serves `compose` (`chat.options`, `chat.new`, and `mode` / `model` on `chat.send`), with `LLMIDE_HOST_API_COMPOSE=1`; models come from the account's Agent SDK list and are re-checked on every send; `chat.new` and `chat.options` use the turn and read buckets. The desktop accepts `chat.send.attachments` and frames them for the engine as `{ path: name, content: text }`.
- **Which chat.** One server-side "Phone chat" per (user, project) (`host_api_project_chat`; `project_id ''` is the legacy/global chat). A list or history frame names its project, and a session from another project is refused.
- **Switches.** `tool_approvals` is served only with `LLMIDE_HOST_API_TOOL_APPROVALS=1`; `chat.history.clear` is
  `denied` unless `LLMIDE_HOST_API_CHAT_CLEAR=1`; `read` (`chat.sessions`, `chat.history`, `usage.get`) only with
  `LLMIDE_HOST_API_READ=1`, rate-limited per device (20-read bucket at 2/s). Chats are the server `chat_sessions`
  rows; the per-user "Phone chat" is flagged `phoneChat`.
- **`hello`.** `hostKind` is `desktop` or `hub` (the core runs `LLMIDE_HUB=1`); `protocolVersion` is `1`.
- **Upgrade paths.** The desktop refuses an upgrade to any path but `/host-api/v1`.
- **Audit.** `audit_log` rows named `host_api.<event>` with an outcome; the write cap closes with 1013.
- **Bind.** In TLS mode the desktop binds IPv4 `0.0.0.0` only.
- **Phone pairing.** The phone pins only from a QR scan. The desktop's Settings pairing card
  (`ui/screens/settings/sections/HostApiPairing.tsx`) shows the `llmide://pair` QR with `ip`, `pin`, `h1port`, `h1fp`
  and `api=1`; `ip` is the first of the PIN answer's `addresses` (Tailscale first, then LAN). The card also shows the
  fingerprint and the payload as text.
