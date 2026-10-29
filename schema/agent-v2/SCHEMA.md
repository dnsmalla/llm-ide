# agent/v2 wire contract

The SSE vocabulary between the Node server (`/agent/v2/stream`) and the Mac app
(`ClaudeLink/AgentV2Event.swift`). One `data:` payload per event.

`agent-v2.schema.json` is the canonical shape. `fixtures/` holds one example per
variant, transcribed from the emitters rather than invented.
`scripts/conformance-agent-v2.mjs` gates all three against each other.

## Why this exists

`docs/explanation/claude-linker.md` used to state that this vocabulary is defined
by `extension/llm_agent/sdk/events.mjs`. **It is not — that file produces 8 of the
15 variants.** The rest come from three files outside the designated linker, and
nothing enforced the claim, so the two sides drifted in both directions: fields
the server emits that Swift never decodes, and fields Swift declares that the
server never sends. That doc now points here instead.

The lesson is inherited from graph-kit, whose Makefile records it plainly:

> schema/fixtures only prove a graph decodes, never that the two engines AGREE,
> which is how the port silently dropped graph-only/related-modules

So the runner does **field-set diffing**, not fixture validation. It asks the
Swift decoder which fields it actually kept and compares that against the
schema. A gap must be listed in the runner's `ALLOWED_UNDECODED` table with a
reason, or the gate fails.

## Who emits what

| Variant | Emitter | Inside the linker? |
|---|---|---|
| `init` `delta` `tool_use_start` `tool_args_delta` `tool_result` `usage` `result` `sdk` `notice` | `llm_agent/sdk/events.mjs` (`mapSdkMessage`, `mapNotice`) | yes |
| `approval_request` (both kinds), `approval_resolved` | `llm_agent/sdk/engine.mjs` (`awaitToolApproval`, `canUseTool`'s AskUserQuestion branch) | yes |
| `mode_set` `tasks` `error` | `routes/agent-v2.mjs` (`send(...)` in the stream handler) | **no** |
| `context_usage` | `llm_agent/sdk/events.mjs` (`mapContextUsage`), emitted by `llm_agent/sdk/engine.mjs` after `result` | yes |
| `tasks_progress` | `llm_agent/runtime/task-session-context.mjs` (`emitTaskProgress`) | **no** |

The four out-of-linker emissions are the drift risk this contract exists to
bound. Moving them inside is tracked separately. **They are not carried by an
ESLint rule** — no such rule exists for event names; the roster check in
`scripts/conformance-agent-v2.mjs` is what notices a new one, by scanning for
`{ type: '...' }` literals and failing on any the schema does not declare.

## `notice` (K1 P2, additive)

One event for the SDK signals the app understands: `retry` (API retry in
progress), `rate_limit` (subscription limit state), `permission_denied`,
`model_fallback` (a refusal moved the turn to the fallback model) and `refusal`
(refusal with no fallback). Each has an env kill switch
(`LLMIDE_V2_ADOPT_RETRY|RATE_LIMIT|PERMISSION_DENIED|REFUSAL=0`) that restores
the previous `sdk` passthrough. `level` is the visibility contract: `info` is
bookkeeping and no client shows it, `warning`/`error` get one status line.
A `notice` never carries `model` (the route meters under an event's `model`).
An OLDER Mac decodes the unknown type as `.sdk("notice")` and ignores it, so no
server API version bump is needed. A fallback's retracted partial text cannot be
retracted on the wire (no message ids); the notice says a fallback happened.

## Deliberate non-decodes

Fields the server sends that the Mac knowingly ignores. Each must also appear in
the runner's `ALLOWED_UNDECODED` table.

The gate reads only that table, never this file, so it can prove an entry is
live (the field is still undecoded) and prove one is stale (Swift now decodes
it, or no fixture carries it) — but it CANNOT tell that this table and that one
have drifted apart. Keeping the two in step is a human job; the table is the
authority, this is the explanation.

| Field | Why |
|---|---|
| `notice.data` (kinds other than `route_switch` and `session_budget`) | Machine-readable detail for the server (audit, subscription limit store) and observers. The Mac renders `kind`/`level`/`text` only: one status line for `warning`/`error`, nothing for `info`. The two session-router kinds are the exception: the Mac decodes their `data` (the route control and meter). |
| `sdk.subtype`, `sdk.raw` | The Mac keeps only `sdkType`; the payload is an observation channel for unknown SDK message types (`AgentV2Event.swift` `SdkWire`). |
| `error.retryable` | **Not a deliberate choice — real drift.** The Mac infers retryability from `code == "SESSION_UNRESUMABLE"` alone, so a future retryable code is invisible to it. Listed so the gate stays green while the fix is scheduled; remove this row when `ErrorWire` gains the field. |
| `approval_request.questions[].options[].preview` | Same: emitted (it is the SDK's own field) and undecodable, so option previews silently do not render. |

## The one place the wire IS the SDK's shape

`engine.mjs` forwards `input.questions` **verbatim** from the SDK's
`AskUserQuestionInput`. Everything else on this wire is ours — snake_case is
mapped to camelCase in `events.mjs`, so an SDK field rename cannot reach the Mac.
`questions` is the exception.

Swift decodes `multiSelect` as **non-optional** (`AgentV2Event.swift`
`AgentV2ApprovalQuestion`). If a future SDK renames it or makes it conditional,
the decode throws, `payload()` returns nil, `.approvalRequest` is never
dispatched, and the turn parks server-side for the full registry timeout —
**900 000 ms, 15 minutes** (`DEFAULT_TIMEOUT_MS` in `llm_agent/sdk/decisions.mjs`).

That is why `questions` is modelled here with `additionalProperties: false`: an
SDK field addition fails this gate rather than the user's turn.

## Not covered by this schema

The legacy `/code-assist` SSE stream (`server/ai-routes.mjs`) emits an event
that also calls itself `error`, but with a different shape — `{type:'error',
error: "…"}` rather than `{code, message, retryable}`. It is a different wire
with a different client path (`CodeAssistSSEEvent`), and unifying the two is out
of scope here. Do not add it to this schema; it would make `error` ambiguous.
