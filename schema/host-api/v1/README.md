# Host API v1 contract

The machine-checked contract for Mac, desktop, iOS and web clients. Design:
[`docs/superpowers/specs/2026-11-03-host-api-design.md`](../../../docs/superpowers/specs/2026-11-03-host-api-design.md).

This directory contains the frame envelope, command registry, event schemas and
fixtures. The Mac host adapter is `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/` (development listener only until TLS lands); Swift validation and payload types are generated into `ios_app/SharedProtocol`.

## Limits

- `apiVersion` is always `1`.
- A frame is at most 1,048,576 bytes.
- Lists default to 100 items, maximum 500.
- A list result is at most `maxListBytes` (786,432 bytes = 768 KiB, measured as UTF-8 JSON of its items), which leaves headroom for the envelope under the frame cap. A host trims a snapshot's message list from the oldest end until it fits; `limit` stays the upper bound on count, so a client gets "the recent N that fit". The newest message is always included, never cut further: its text is already clamped to 100,000 characters, at most ~600 KB even fully escaped, so it always fits the budget alone. No wire field says a list was trimmed.
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

All 12 commands are listed below.

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

The remaining spec domains (Explorer, Auto Tasks, Loop, projects, files, SCM,
issues, Self-Heal, generation, usage, activity) are added by later plans using
the same envelope and registry machinery.

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

The desktop host adapter is `extension/routes/host-api/` (gateway, frame codec, session gate, translator) with the listener in `extension/server/host-api-listener.mjs` — development loopback only until TLS lands. The desktop UI mints the pairing PIN and manages paired devices through `POST /host-api/pin`, `GET /host-api/devices` and `DELETE /host-api/devices/:id` (contract `schema/http/host-api.schema.json`).

The web client is `web/` (`web/src/host-api/connection.ts`), and its types are generated into `web/src/host-api/types.generated.ts` by `scripts/generate-host-api.mjs`.
