# Host API v1 contract

The machine-checked contract for Mac, desktop, iOS and web clients. Design:
[`docs/superpowers/specs/2026-11-03-host-api-design.md`](../../../docs/superpowers/specs/2026-11-03-host-api-design.md).

This directory contains the frame envelope, command registry, event schemas and
fixtures. It does not contain a host adapter or a client; those are later plans.

## Limits

- `apiVersion` is always `1`.
- A frame is at most 1,048,576 bytes.
- Lists default to 100 items, maximum 500.
- Error messages are at most 500 characters.

## Workflow

1. Add or change the command in `commands.json`.
2. Add both fixtures under `fixtures/commands/<command>.request.json` and
   `.result.json`.
3. Add or change the event in `events.schema.json` and add its fixture under
   `fixtures/events/`.
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

Events are the six flat variants in `events.schema.json`: `chat.delta`,
`chat.done`, `chat.error`, `approval.request`, `approval.cleared` and
`toolApproval.request`. Each variant is a complete object schema with its own
`payload`; they are not composed with `allOf`.

## Snapshots

`host.snapshot` returns a `snapshots` map. Per-domain snapshot payloads are
opaque in v1; clients should request the typed domain snapshot command for a
concrete shape.

## Ordering

Frame ordering is the envelope `rev` on the frame itself. Snapshot command
results do not repeat it in `result`; async errors may carry the same optional
`rev`.
