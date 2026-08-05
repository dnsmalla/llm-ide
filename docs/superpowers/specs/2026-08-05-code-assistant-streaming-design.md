# Code Assistant Chat — Real Token Streaming — Design

**Date:** 2026-08-05
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/Sources/LlmIdeMac/Views/CodeAssistant/`) + server (`extension/agents/runtime.mjs`, `extension/agents/providers.mjs`, `extension/server/ai-routes.mjs`)

## Goal

Make the Code Assistant chat feel like Claude.ai's chat: the reply appears live, word by word, instead of the UI showing a "Thinking…"/"Writing…" status label for the whole duration and then dumping the complete reply in one lump. Add a working Stop button that actually kills generation mid-stream, not just the HTTP request.

**Confirmed with the user before designing:**
- Streaming is the priority — not other Claude.ai UI differences (message editing, layout, etc.), which are out of scope for this spec.
- The user's own auth is `claude login` (CLI), not a personal API key, and they also use other models — so streaming must work for the CLI-invocation path, not just the existing API-key path.
- Scope: all CLI providers (Claude, Codex/openai, Gemini/google) and the API-key path, in one pass — not phased by provider.
- A Stop button that cancels generation mid-stream is wanted alongside streaming.

## Background — current state

`/code-assist`'s SSE path already streams **progress labels** ("thinking" / "tool: search-kb" / "writing") via `onProgress` → `writeEvent({type:'progress', ...})`, but the actual reply text arrives exactly once, complete, in a terminal `writeEvent({type:'done', reply: out.reply, ...})` — confirmed by an existing code comment stating token-level streaming of the synthesis turn was "a separate follow-up." Every model call today goes through `runClaude()` (`extension/agents/runtime.mjs`), which uses `spawnCli()` → Node's `execFile()` — buffers the CLI's entire stdout and only resolves once the process exits. A streaming counterpart, `runClaudeStream()`, already exists but only produces *real* incremental output for the direct-Anthropic-API path (when a personal API key is configured); for the CLI path (`streamProvider !== 'anthropic'` or no `apiKey`) it silently falls back to running `runClaude()` and delivering the whole result as a single `onChunk` call — i.e. today it cannot help the CLI-login case at all.

A full review of the Mac chat's existing feature set (message lifecycle, tool-confirmation sheets, attachments, bash/git/PR integration, voice input, session/history management) surfaced constraints this design must respect — see "Constraints from existing features" below.

## Decisions (from brainstorming)

- **Real streaming across all CLI providers + the API-key path**, not phased. Claude's CLI has a documented streaming output mode (`--output-format stream-json`); Codex and Gemini CLIs are checked for an equivalent during planning. Whichever providers lack one keep today's fully-buffered behavior for now (delivered as a single chunk through the same pipeline) — never a regression, just not incrementally rendered yet for that provider.
- **Only the final synthesis turn streams.** Intermediate agent-loop turns (delegate, tool calls) keep today's buffered `runClaude` + `progress` events — their raw output was never shown as chat text, so streaming them adds no visible value.
- **Add a Stop button that kills the underlying process**, not just the HTTP connection — extending the existing `stop()` (already cancels the wrapping `Task` and the `URLSession` request) so the abort signal also reaches the spawned CLI child process.
- **Repurpose `revealAssistantReply`'s existing plumbing** (the client-side-only typewriter effect that already reveals an already-complete reply over ~28 throttled steps) rather than building a parallel incremental-rendering mechanism. Real chunks, when available, feed the same throttled append/render path; a provider with no streaming adapter delivers one big fallback chunk that gets client-side re-chunked into the same cadence — so every provider gets a smooth reveal, whether or not its backend truly streams yet.
- **Partial replies survive Stop.** Today, stopping discards the in-flight reply entirely (nothing is ever committed to `history` until it's complete). Once partial text is visible mid-stream, Stop leaves that partial text in `history`, marked with a subtle "Stopped" affordance — matching Claude.ai's behavior — rather than vanishing it.
- **One shared turn-append mechanism**, used by `runTurn`, `sendFollowup`, and every tool-confirm flow (issue/PR/git-op/bash results) alike — today these independently call `history.append(assistantTurn)` in three+ separate places; duplicating streaming logic into each would reintroduce exactly the "fixed one copy, missed the others" class of bug this session has repeatedly found and fixed elsewhere in this codebase.

## Architecture

```
Mac: ChatComposer.submit() → startTurn() → runTurn()
   │
   ▼
codeAssistRoundTrip() → LlmIdeAPIClient.codeAssistStream()
   │  SSE: Accept: text/event-stream
   ▼
POST /code-assist (ai-routes.mjs)
   │  agent loop: delegate → tool calls (buffered runClaude + 'progress' events,
   │  unchanged) → final synthesis turn
   ▼
Final synthesis call → streamModelReply() [NEW, runtime.mjs]
   │  tries in order:
   │   1. direct Anthropic API streaming (existing runClaudeStream code, unchanged)
   │   2. spawnCliStream() [NEW, providers.mjs] — per-provider streaming adapter
   │   3. fully-buffered runClaude(), delivered as ONE onChunk call (guaranteed fallback)
   ▼
onChunk(delta) → writeEvent({type:'chunk', text: delta})   [NEW SSE event]
   │  ... repeats as text is generated ...
   ▼
writeEvent({type:'done', reply: <complete text, for consistency check>,
            pendingTool, tasks, continueNeeded, usage})    [unchanged shape]
   │
   ▼
Mac: LlmIdeAPIClient+CodeAssist.swift SSE switch
   │  case "chunk" → appendStreamedChunk(turnId, delta)   [NEW]
   │  case "done"  → finishStreamingTurn(turnId, ...)      [NEW, replaces the old
   │                  one-shot history.append + revealAssistantReply call]
   ▼
history[idx].content mutated in place (CodeAssistTurn.content becomes `var`)
   │  renders via existing throttled reveal cadence, reused for both
   │  real per-chunk arrival AND the single-chunk fallback case
```

**Stop button**: `stop()` cancels `runTask` (as today) — this already tears down the `URLSession` SSE read, which the server observes via `req.on('close')` → `ac.abort()` (existing). New: `ac.signal` is threaded into `spawnCliStream()`, which calls `child.kill()` on abort, so the underlying `claude`/`codex`/`gemini` process actually dies instead of continuing to burn CPU/tokens after the client walks away.

## Components

**Server (`extension/`):**
- `agents/providers.mjs` — new `spawnCliStream(provider, prompt, {onChunk, signal, ...})`: `child_process.spawn()` instead of `execFile()`, incremental stdout reading, per-provider line-parser adapter (`{ anthropic: parseStreamJSON, openai: ?, google: ? }` — Codex/Gemini adapters investigated at plan time; absent adapter ⇒ buffered-as-one-chunk fallback within this same function, so callers never need to know which mode was used). Wires `signal` to `child.kill()` on abort.
- `agents/runtime.mjs` — new `streamModelReply(prompt, opts)`: tries direct-API streaming (existing code) → `spawnCliStream` → buffered `runClaude` (guaranteed fallback), in that order. `runClaudeStream` stays as the direct-API-only primitive it already is; this new function is the provider-agnostic entry point `ai-routes.mjs` calls instead.
- `server/ai-routes.mjs` — `/code-assist`'s final synthesis call switches from `runClaude` to `streamModelReply`, with `onChunk` wired to `writeEvent({type:'chunk', text})`. Intermediate agent-loop calls (delegate/tool) are unchanged. `ac.signal` (already exists) is passed through to `streamModelReply`/`spawnCliStream`.

**Mac (`mac/Sources/LlmIdeMac/`):**
- `Services/API/LlmIdeAPIClient+CodeAssist.swift` — `CodeAssistEvent`/SSE switch gains a `"chunk"` case (`text: String`); `CodeAssistTurn.content` becomes `var` (from `let`).
- `Views/CodeAssistant/CodeAssistantPanel+Session.swift` — new shared helpers replacing the duplicated `history.append(assistantTurn)` call sites in `runTurn`, `sendFollowup`, and (via the same call path) every tool-confirm flow:
  - `beginStreamingTurn() -> UUID` — appends a placeholder assistant turn, marks it as the active streaming turn (reusing/renaming the existing `revealingTurnID` state).
  - `appendStreamedChunk(_ id: UUID, _ text: String)` — appends to that turn's content; batches UI updates on the existing throttle cadence (reused from `revealAssistantReply`, ~20ms ticks) rather than re-rendering per chunk — protects `SelfSizingMarkdownView` from a full `WKWebView` reload per token.
  - `finishStreamingTurn(_ id: UUID, pendingTool:, tasks:, continueNeeded:, usage:, stopped: Bool)` — the single place that: fires the VoiceOver announcement once, sets `pendingTool`/`agentPendingTasks`, schedules auto-continue, runs auto-apply/auto-git-op logic (all exactly as today, just moved here from the tail of `runTurn`), and — when `stopped` — leaves the partial content in place with a "Stopped" marker instead of discarding it.
  - Fallback (no real per-chunk delivery for this call): the client receives the whole text in the `chunk`/`done` sequence as today's server already guarantees (buffered path delivers one chunk), and locally re-splits it into the existing ~28-step reveal cadence before feeding it through the same `appendStreamedChunk` path — so the visual experience is consistent regardless of backend capability.
  - `resetActiveTurnState()` (session switch) additionally cancels/discards any in-flight streaming turn the same way it already cancels `runTask`/`revealTask`.
  - `sendFollowup()` and every tool-confirm flow (`confirmCreateIssue`, `runGitOpFlow`, `runBashCommand`, `confirmPRCreation`, etc.) call `beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn` instead of their own `history.append(...)` — one mechanism, not five copies.
- `Views/CodeAssistant/ChatComposer.swift` — Stop button behavior unchanged in shape (`stop()` already exists); no new UI element needed beyond what's already there.
- The old `revealAssistantReply`/`revealedCount` fixed-schedule implementation is removed once its cadence logic has been folded into `appendStreamedChunk`'s fallback path — not kept as a second parallel mechanism.

## Error handling

- **Provider CLI streaming parse failure mid-stream**: finalize whatever text arrived so far via `finishStreamingTurn` rather than erroring the whole turn (matches "never worse than today" — today a mid-stream failure would've meant no reply at all).
- **User hits Stop**: `finishStreamingTurn(..., stopped: true)` — partial text stays in `history` with a "Stopped" marker; no error bubble (matches today's cancellation UX, which already treats `CancellationError`/`URLError.cancelled` as "stopped, not failed").
- **Provider has no streaming adapter**: fully transparent to the user — same visual reveal cadence, just sourced from one fallback chunk instead of many real ones.
- **Session switch mid-stream**: `resetActiveTurnState()` cancels the streaming turn the same way it already cancels `runTask`/`revealTask` today — no writes land in the wrong session's `history`.

## Testing

- Server: unit tests per provider's streaming line-parser (sample CLI stream-output → expected text deltas), a test proving `spawnCliStream`'s abort actually kills the child process (not just resolves the promise), and a regression test that intermediate agent-loop turns are unaffected (still buffered, still only emit `progress` events) — guards against accidentally streaming the wrong turn.
- Server: regression test that a provider with no streaming adapter still returns a correct, complete final reply via the guaranteed-buffered fallback path.
- Mac: no XCTest available in this environment (established limitation this session) — verified via `swift build` plus manual exercise of the chat against a running local server, covering: normal streaming reveal, Stop mid-stream (partial text + "Stopped" marker persists), a tool-confirm flow's reply (issue creation → `sendFollowup` → streamed acknowledgement), and session-switch mid-stream (no leaked writes into the new session).

## Out of scope

- Other Claude.ai UI/UX differences (message editing, regenerate, layout changes) — explicitly deferred per the user's stated priority.
- Streaming intermediate agent-loop turns (delegate/tool calls) — their output was never user-visible text and streaming them adds no value.
- A full rewrite of CLI invocation onto an SDK client (considered and rejected — this app deliberately uses CLI-based auth so users don't need to manage API keys; an SDK-based rewrite would undermine that specifically for the sake of this feature).
