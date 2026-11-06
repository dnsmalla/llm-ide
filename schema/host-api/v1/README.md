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
- `chat.sessions` pages by `offset` (at most 100 per page; `nextOffset` is present while more exist). `chat.history` pages backwards by `beforeSeq` (`nextBeforeSeq` is present while older messages exist) and is trimmed to `maxListBytes` like `chat.snapshot`: oldest dropped first, the newest always kept, with `nextBeforeSeq` pointing at the oldest kept message.
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

All 15 commands are listed below.

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
| `approvals.answer` | approvals | no | `approval_answer` |
| `toolApprovals.answer` | tool_approvals | no | `tool_approval_answer` |
| `chat.sessions` | read | yes | — |
| `chat.history` | read | yes | — |
| `usage.get` | read | yes | `usage_get` |

`read` (tier R in the command bus spec) is the read-only slice: the user's chat list, one chat's history, and the usage and limits summary. It is served only when the host enables it (desktop: `LLMIDE_HOST_API_READ=1`, default off) and only to a device paired while it was served. The Tauri app passes only `LLMIDE_HOST_API_TLS` and `LLMIDE_HOST_API_WEB_ORIGINS` to a core it starts (`desktop/src-tauri/src/core_env.rs` drops every other `LLMIDE_*`), so `read` works only on a core you start yourself (`cd extension && LLMIDE_HOST_API_READ=1 npm run server`), which the app then adopts; it fails closed otherwise. The remaining spec domains (Explorer, Auto Tasks, Loop, projects, files, SCM, issues, Self-Heal, generation, Library, activity) are added by later plans using the same envelope and registry machinery.

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

The Mac and desktop hosts serve the same commands, codes and shapes. Where they legitimately differ:

- **Gate prose.** Refusal messages say "This Mac…" on the Mac and "This computer…" on the desktop; the error `code`s (and `retryable`) are identical. Clients branch on `code`, never on message text.
- **Engine rejections.** On the desktop, a turn refusal whose code it does not know (anything but `TURN_IN_PROGRESS`, `SDK_UPDATING`, `PLUGIN_UPDATING`, `ROUTE_UNAVAILABLE`, `SESSION_TOKEN_LIMIT`, `SLASH_COMMAND_FAILED`) becomes a `chat.error` with a generic message and `retryable: false`. The Mac turns its v2 `CommandError` into a `chat.error` carrying that message (`HostApiV2ChatBridge`), with no `retryable` flag.
- **Snapshot trimming.** Both hosts trim `chat.snapshot` / `host.snapshot` messages to `maxListBytes` the same way (see Limits): oldest dropped first, the newest always kept.
- **Which chat.** The Mac serves its shared quick chat (the same one the iPhone's v2 chat uses); the desktop serves one server-side "Phone chat" per user. On the Mac a chat history that cannot be read answers `capability_unavailable`; the desktop has no such state.
- **Switches.** `tool_approvals` is served on the desktop only with `LLMIDE_HOST_API_TOOL_APPROVALS=1`, on the Mac per its setting; `chat.history.clear` is `denied` on the desktop unless `LLMIDE_HOST_API_CHAT_CLEAR=1`. The Mac also applies its phone tier gate to `chat.send` and both approval answers (`denied`).
- **Reads.** Only the desktop serves `read` (`chat.sessions`, `chat.history`, `usage.get`). Its chats are the server `chat_sessions` rows, and the per-user "Phone chat" is flagged `phoneChat`. The Mac does not serve `read` yet, so its gate answers `capability_unavailable`. The desktop also rate-limits reads per device (20-read bucket at 2/s); the Mac has no read bucket.
- **`hello`.** `hostKind` is `mac` or `desktop`; `protocolVersion` is the Mac's v2 protocol version on the Mac and `1` on the desktop.
- **Upgrade paths.** The desktop refuses an upgrade to any path but `/host-api/v1`. The Mac can't: Network.framework exposes no path.
- **Peer on refusals.** On the Mac, `origin_refused` has peer `-` (no connection is handed to the request handler), so it is de-duplicated as one row per minute.
- **Audit.** The desktop writes `audit_log` rows named `host_api.<event>` with an outcome. The Mac writes JSONL rows (`~/Library/Application Support/llm-ide/host-api-audit.jsonl`, mode 0600, rotated at 512 KiB) with no outcome column. Mac-only events: `connection_limit` and `handshake_timeout`. The Mac write cap closes by cancelling the connection; the desktop closes with 1013.
- **v2 tokens.** On the Mac, a token minted by the plaintext v2 link (`ws://…:3006`) also authenticates on v1, with the legacy scopes only (never `tool_approvals`). The v2 server and the v1 gateway share one PIN throttle (one instance owned by `MobileControlManager`, keyed by `peerKey`, one global cap): a wrong PIN on either path counts against both, and a correct PIN clears the record on both. Token throttles stay separate per path. The desktop has no v2 link.
- **Bind.** In TLS mode the desktop binds IPv4 `0.0.0.0` only; the Mac listener is dual-stack.
- **Phone pairing.** The phone pins only from a QR scan. Both hosts show the `llmide://pair` QR in TLS mode. The Mac's carries its v2 `port` too; the desktop's Settings pairing card (`ui/screens/settings/sections/HostApiPairing.tsx`) shows `ip`, `pin`, `h1port`, `h1fp` and `api=1` with no `port`, since the desktop has no v2 link and a pinned phone dials only v1. `ip` is the first of the PIN answer's `addresses` (Tailscale first, then LAN). The card also shows the fingerprint and the payload as text.
