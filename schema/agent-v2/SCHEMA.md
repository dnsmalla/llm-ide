# agent/v2 wire contract

The SSE vocabulary of the Node server's `/agent/v2/stream` (read by the desktop
and web chat, `ui/screens/chat/`). One `data:` payload per event.

`agent-v2.schema.json` is the canonical shape. `fixtures/` holds one example per
variant, transcribed from the emitters rather than invented.
`scripts/conformance-agent-v2.mjs` gates all three against each other.

## Why this exists

`docs/explanation/claude-linker.md` used to state that this vocabulary is defined
by `extension/llm_agent/sdk/events.mjs`. **It is not — that file produces 8 of the
15 variants.** The rest come from three files outside the designated linker, and
nothing enforced the claim. That doc now points here instead.

The runner checks fixture validity, schema coverage, and an emitter roster (below).
(Until 2026-11-06 it also diffed the fields the Swift Mac app decoded; that check
went with the Mac app.)

## Who emits what

| Variant | Emitter | Inside the linker? |
|---|---|---|
| `init` `delta` `tool_use_start` `tool_args_delta` `tool_result` `usage` `result` `sdk` `notice` | `llm_agent/sdk/events.mjs` (`mapSdkMessage`, `mapNotice`) | yes |
| `approval_request` (both kinds), `approval_resolved` | `llm_agent/sdk/engine.mjs` (`awaitToolApproval`, `canUseTool`'s AskUserQuestion branch) | yes |
| `mode_set` `tasks` `error` | `routes/agent-v2.mjs` (`send(...)` in the stream handler) | **no** |
| `context_usage` | `llm_agent/sdk/events.mjs` (`mapContextUsage`), emitted by `llm_agent/sdk/engine.mjs` after `result` | yes |
| `tasks_progress` | `llm_agent/tasks/task-session-context.mjs` (`emitTaskProgress`) | **no** |

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
A fallback's retracted partial text cannot be
retracted on the wire (no message ids); the notice says a fallback happened.

## The one place the wire IS the SDK's shape

`engine.mjs` forwards `input.questions` **verbatim** from the SDK's
`AskUserQuestionInput`. Everything else on this wire is ours — snake_case is
mapped to camelCase in `events.mjs`, so an SDK field rename cannot reach a client.
`questions` is the exception.

A client that requires `multiSelect` and gets a renamed or missing field cannot
show the question, and the turn parks server-side for the full registry timeout —
**900 000 ms, 15 minutes** (`DEFAULT_TIMEOUT_MS` in `llm_agent/sdk/decisions.mjs`).

That is why `questions` is modelled here with `additionalProperties: false`: an
SDK field addition fails this gate rather than the user's turn.

## Not covered by this schema

The legacy `/code-assist` SSE stream (`server/ai-routes.mjs`) emits an event
that also calls itself `error`, but with a different shape — `{type:'error',
error: "…"}` rather than `{code, message, retryable}`. It is a different wire
with a different client path, and unifying the two is out
of scope here. Do not add it to this schema; it would make `error` ambiguous.
