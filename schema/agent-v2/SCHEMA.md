# agent/v2 wire contract

The SSE vocabulary between the Node server (`/agent/v2/stream`) and the Mac app
(`ClaudeLink/AgentV2Event.swift`). One `data:` payload per event.

`agent-v2.schema.json` is the canonical shape. `fixtures/` holds one example per
variant, transcribed from the emitters rather than invented.
`scripts/conformance-agent-v2.mjs` gates all three against each other.

## Why this exists

`docs/explanation/claude-linker.md` states that this vocabulary is defined by
`extension/llm_agent/sdk/events.mjs`. **It is not — that file defines 8 of the 15
variants.** The rest come from three files outside the designated linker. Nothing
enforced the claim, so the two sides drifted in both directions: fields the
server emits that Swift never decodes, and fields Swift declares that the server
never sends.

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
| `init` `delta` `tool_use_start` `tool_args_delta` `tool_result` `usage` `result` `sdk` | `llm_agent/sdk/events.mjs:33-117` (`mapSdkMessage`) | yes |
| `approval_request` (both kinds), `approval_resolved` | `llm_agent/sdk/engine.mjs:793,795,906,912` | yes |
| `mode_set` `tasks` `error` | `routes/agent-v2.mjs:257,340,350,368` | **no** |
| `tasks_progress` | `llm_agent/runtime/task-session-context.mjs:53` | **no** |

The four out-of-linker emissions are the drift risk this contract exists to
bound. Moving them inside is tracked separately; until then the ESLint rule
carries them in one commented allow-list.

## Deliberate non-decodes

Fields the server sends that the Mac knowingly ignores. Each must also appear in
the runner's `ALLOWED_UNDECODED` table — this document and that table are the
same statement in two places, and the gate keeps them honest.

| Field | Why |
|---|---|
| `sdk.subtype`, `sdk.raw` | The Mac keeps only `sdkType`; the payload is an observation channel for unknown SDK message types (`AgentV2Event.swift` `SdkWire`). |
| `error.retryable` | **Not a deliberate choice — real drift.** The Mac infers retryability from `code == "SESSION_UNRESUMABLE"` alone, so a future retryable code is invisible to it. Listed so the gate stays green while the fix is scheduled; remove this row when `ErrorWire` gains the field. |
| `approval_request.questions[].options[].preview` | Same: emitted (it is the SDK's own field) and undecodable, so option previews silently do not render. |

## The one place the wire IS the SDK's shape

`engine.mjs:906` forwards `input.questions` **verbatim** from the SDK's
`AskUserQuestionInput`. Everything else on this wire is ours — snake_case is
mapped to camelCase in `events.mjs`, so an SDK field rename cannot reach the Mac.
`questions` is the exception.

Swift decodes `multiSelect` as **non-optional** (`AgentV2Event.swift`
`AgentV2ApprovalQuestion`). If a future SDK renames it or makes it conditional,
the decode throws, `payload()` returns nil, `.approvalRequest` is never
dispatched, and the turn parks server-side for the full registry timeout —
**900 000 ms, 15 minutes** (`llm_agent/sdk/decisions.mjs`), not the 300 s several
comments claim.

That is why `questions` is modelled here with `additionalProperties: false`: an
SDK field addition fails this gate rather than the user's turn.

## Not covered by this schema

The legacy `/code-assist` SSE stream (`server/ai-routes.mjs`) emits an event
that also calls itself `error`, but with a different shape — `{type:'error',
error: "…"}` rather than `{code, message, retryable}`. It is a different wire
with a different client path (`CodeAssistSSEEvent`), and unifying the two is out
of scope here. Do not add it to this schema; it would make `error` ambiguous.
