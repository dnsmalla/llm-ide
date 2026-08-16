# Mac Chat Professional Refactor — Design

Date: 2026-08-16
Status: Approved (approach A: engine-first strangler)
Scope: `mac/` (primary), `ios_app/` only if the phone chat path needs it. Server
(`extension/`) is touched only where it powers the Mac chat engine — the Chrome
extension UI is out of scope.

## Problem

The Mac chat works but is structured like a prototype that grew. The turn
engine — streaming, stop, queue drain, auto-chaining, session switching, the
side-effect-aware fallback — lives in a 906-line view extension
(`CodeAssistantPanel+Session.swift`) with **zero test coverage**. State is
sprawled across ~45 `@State` fields; cross-component contracts are string
conventions inside message content (`"("`-prefix acks, `"(bash result - exit
code: N)"` round-trip parsing, `"_(stopped)_"` suffix mutation); turn ids are
re-minted on every decode, which is the root cause of those conventions. Every
history change rewrites the session file synchronously on the main thread;
every streamed chunk reloads a WKWebView; persisted history is silently capped
at 50 turns; `turnModes`/`bubbleHeights` leak across session switches; the
error bubble has no Retry. Three chat surfaces (Code Assistant panel,
`LlmChatSheet`, mobile `explore_chat` proxy) duplicate the flow with divergent
behavior, and there are two markdown implementations.

This structure blocks the product goal — a flagship chat that uses the local
agent, repo + session memory, skills, and hooks to beat Claude chat — because
every new capability lands in an untestable, string-coupled surface.

## Goals

1. Turn lifecycle logic extracted into a testable engine with real coverage.
2. One message model with stable persisted ids, status, timestamps, and
   structured tool steps/pending actions — no content-string protocols.
3. All three chat surfaces run on one engine and one markdown path.
4. No silent data loss (50-turn cap, cross-session leaks, dropped drafts of
   queued messages on quit), persistence off the main thread.
5. Streaming render cost bounded; full markdown render once per turn.
6. Failure UX: per-message failure with Retry; offline state visible in chat.
7. Behavior-preserving where users can tell: every phase ships green on
   `main`, revertable, all 421 existing tests stay green.

## Non-goals (this spec)

- Capability wiring (memory recall UI, skills cockpit, hooks integration) —
  separate follow-up spec; this refactor builds the seams it needs.
- Server protocol changes (SSE heartbeat, `/kb/agent/ask` abort, agent-ask
  SSE) — separate server-side work.
- New chat features (attachments DnD, image paste, export, full-text search).
- iOS app changes (the phone relay benefits automatically through the shared
  server path).

## Current state (evidence)

- Turn lifecycle: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift`
  — `runTurn`, `sendFollowup`, `codeAssistRoundTrip` (SSE + one buffered
  fallback retry, only when no progress was seen), `beginStreamingTurn` /
  `appendStreamedChunk` / `finishStreamingTurn`, `autoChainPendingAction`,
  session CRUD (`persistCurrentChat`, `switchSession`, `deleteSession`,
  `mintFreshSession`), history packing (`historyForRequest`, 400 k chars /
  24 k per turn, first-user-turn anchor).
- SSE parsing: `LlmIdeAPIClient+CodeAssist.swift` — events
  `progress | chunk | done | tasks | error`; `.agent` vs `.http` error mapping
  encodes the no-retry-after-progress rule; `tasks` arrives as a separate
  event after `done`.
- Persistence: `ChatSessionStore` (static enum, synchronous file I/O, atomic
  writes, `.corrupt-<ts>` quarantine, legacy scope-file migration) writing
  `~/Library/Application Support/llm-ide/sessions/<uuid>.json` as
  `{storeVersion: 1, id, scope?, title, createdAt, lastUsedAt,
  history: [{role, content}]}` — turn ids are deliberately stripped on encode
  and re-minted on decode.
- Other surfaces: `LlmChatSheet` (buffered `/kb/agent/ask`, plain-text
  rendering, 2 s polling, no Stop) and `MobileControlManager.handleExploreChat`
  (same `codeAssistStream`, `onChunk` no-op, persists into `ChatSessionStore`).
- Known defects to fix as part of the refactor: 50-turn `suffix(50)` persist
  cap; `turnModes`/`bubbleHeights` never cleared on session switch; drafts and
  queued messages lost on quit; single dismiss-only error bubble.

## Target architecture

New module `mac/Sources/LlmIdeMac/Chat/`:

```
Chat/
├── ChatEngine.swift            @MainActor @Observable — history, busy/queue,
│                               streaming state, stop, session switching
│                               (epoch guard), nudge logic, tool-step recording
├── ChatMessage.swift           model v2 (below)
├── ChatSession.swift           moved from Models/ (scope + v2 envelope)
├── ChatSessionStore.swift      moved from Services/; actor-isolated async API
├── ChatTransport.swift         protocol send/stream; CodeAssistTransport
│                               (SSE + buffered fallback), AgentAskTransport
│                               (buffered)
├── ChatEngine+AutoChain.swift  approval / auto-run policy extracted from
│                               autoChainPendingAction (edit-mode rules,
│                               truncated-path guard, per-turn budget)
└── ChatMarkdownRenderer.swift  single markdown path (WKWebView + highlight.js
                               for final render; plain-text mode for previews
                               and streaming)
```

`CodeAssistantPanel` and its subviews become views over engine state. The
panel keeps only true view state: draft, `expandedTurns`, sheet/popover flags,
composer autocomplete. `ChatMessageList` reads `ChatMessage` directly (its
20+ initializer parameters collapse).

The transport seam is what unifies the surfaces:

| Surface | Transport | Gains |
|---|---|---|
| Code Assistant panel (4 scopes) | `CodeAssistTransport` | behavior preserved, tests |
| Mobile `explore_chat` proxy | `CodeAssistTransport` via engine | same engine instance per scope |
| `LlmChatSheet` (llm-chat) | `AgentAskTransport` | markdown, Stop, engine semantics |

Wire format is unchanged in phases 1–5: the engine encodes `ChatMessage` to
the existing `{role, content}` turn shape at the transport boundary.

## Message model v2

```swift
struct ChatMessage: Identifiable, Codable, Equatable {
    enum Role: String, Codable { case user, assistant, toolResult }
    enum Status: String, Codable { case streaming, done, stopped, failed }
    struct ToolStep: Codable, Equatable { let label: String; let tool: String?; let at: Date }
    struct PendingAction: Codable, Equatable { /* PendingTool wire type + ack state */ }
    struct Metadata: Codable, Equatable {
        var mode: String?
        var usage: UsageSummary?        // attachment/memory counts shown today
        var skills: [String]?
        var failedError: String?        // status == .failed
        var retryPayload: RetryPayload? // original message/attachments/skills
    }
    let id: UUID                 // persisted; stable across load/save
    let role: Role
    var content: String
    var status: Status
    let createdAt: Date
    var toolSteps: [ToolStep]
    var pendingAction: PendingAction?
    var metadata: Metadata?
}
```

- Synthetic `"("` acks become `role: .toolResult` messages with a structured
  payload (kind: edit | bash | git | issue; exit code; line delta; url).
  `CommandOutputView` renders the struct; `BashResultDisplay.parse` and the
  `hasPrefix("(")` checks are deleted.
- Stopped is `status: .stopped`; `"_(stopped)_"` content mutation is deleted.
- `turnActivity[turnID]` side-table → `message.toolSteps`; `turnModes[id]` →
  `message.metadata.mode`; both stop leaking across sessions by construction.
- Session file v2: `{storeVersion: 2, id, scope, title, createdAt, lastUsedAt,
  messages: [ChatMessage]}`. Decoding accepts v1 (`history: [{role, content}]`)
  and upgrades in memory: minted ids, `.done` status, `createdAt = session
  dates`, tool acks detected by the legacy `"("`/bash-result conventions and
  converted to `.toolResult` messages. Files are rewritten in v2 on next save;
  v1 decode failures still quarantine exactly as today.
- `historyForRequest` encodes `.user`/`.assistant` messages to plain wire
  turns; `.toolResult` messages are also included, re-encoded as user turns
  with the same synthetic text format the server receives today (the server
  keeps seeing the old shape until a follow-up teaches it the new role).

## Engine data flow

```
Composer.submit
  → engine.send(text, skills, attachments)
    → append .user message; record nudge state
    → append .streaming placeholder
    → transport.stream(...)
        onProgress → status line + append ToolStep (same dedup rule)
        onChunk    → append content (coalesced, ≤10 publishes/sec)
        done/tasks → finalize
    → finalize(.done, pendingAction, tasks, usage, mode)
    → autoChain policy (edit-mode rules, truncated-path guard, budget)
  → view confirmers call engine.acknowledge(action, result)
    → append .toolResult message → engine.followUp()
```

- `engine.stop()` cancels the task; the placeholder finalizes as `.stopped`
  with partial content preserved; queue drains exactly as today (fresh task,
  no inherited cancellation).
- Session switching keeps the epoch-guard semantics; the engine owns
  `sessionEpoch`, and `switchSession` persists the outgoing session, resets
  transient state, and reloads — testable without a view.
- Cancellation/failure classification (CancellationError / URLError.cancelled
  vs real failures) and the fallback-retry rule (retry buffered only when no
  progress was seen) move into `CodeAssistTransport` verbatim.
- Retry UX: a `.failed` message carries `retryPayload`; the Retry button calls
  `engine.retry(messageID)`, which re-sends and replaces the failed message's
  status on success.

## Persistence

- `ChatSessionStore` becomes an actor (test override directory preserved).
  API: `list`, `load`, `save` (debounced ~500 ms, atomic write, off main),
  `flush(now:)`, `delete`, `clear`. Engine schedules saves; forced flush on
  session switch/delete and `NSApplication.willTerminate`.
- Full history persisted — the `suffix(50)` cap is deleted; wire budgets
  (`historyForRequest`, server `selectHistoryTurns`) remain the only limits.
- Drafts and the send queue persist per session (in the v2 file) so a quit
  mid-conversation loses nothing; restored on load.

## Rendering performance

- While a message is `.streaming`, the bubble renders plain `Text` (fast) with
  the existing reveal behavior; the WKWebView markdown render runs once when
  the message finalizes. No per-chunk `loadHTMLString`.
- Chunk coalescing: engine buffers chunks and publishes at most every 100 ms.
- One markdown implementation: `ChatMarkdownRenderer` (vendored highlight.js,
  copy buttons, GFM) used by chat bubbles, `LlmChatSheet`, and collapsed
  previews (its plain-text mode replaces the regex `markdownPreview`).

## Error handling & UX

- Per-message failure: `.failed` status + `failedError` + Retry (from
  `retryPayload`). The single dismiss-only error bubble is removed once
  messages carry failure.
- Offline: chat header shows a reconnecting state from `BackendManager`
  health; send is disabled (not silent) while down.
- `LlmChatSheet`: Stop button wired to engine task cancellation; markdown
  rendering; polling unchanged until server adds push/SSE.

## Testing

Phase-gated; tests land before each extraction:

1. **Characterization tests (phase 1)** — scripted `ChatTransport` double
   emitting: progress/chunk/done/tasks sequences, error events, stream abort
   mid-chunk, no-`done` termination with and without prior progress, buffered
   fallback trigger, cancellation mid-stream. Assert the observable state
   machine (busy, placeholder lifecycle, stopped-tagging, queue drain,
   fallback-retry-only-when-no-progress) against **current** panel behavior
   before moving any code.
2. **Engine unit tests** — send/finalize/stop/queue; session-switch epoch
   races (stale catch after switch); `historyForRequest` packing (ported from
   ad-hoc verification to tests); auto-chain policy table (edit modes ×
   truncated paths × budget); nudge recording.
3. **Migration tests** — v1 → v2 decode (incl. `"("`-ack and bash-result
   conversion), v2 round-trip id stability, corrupt-file quarantine,
   legacy scope-file migration preserved.
4. **Store tests** — debounce/flush semantics, atomic write, no main-thread
   blocking (measured), sign-out wipe.
5. Gate: `make test-mac` green (421 existing + new) and `make regression`
   before each phase merge.

## Phases

| # | Deliverable | Ships |
|---|---|---|
| 1 | Characterization tests against current behavior (no prod code moved) | tests only |
| 2 | `ChatEngine` + `ChatTransport` extraction; panel delegates to engine; behavior-identical | refactor |
| 3 | `ChatMessage` v2 + store v2 + migration; delete string conventions | refactor |
| 4 | `LlmChatSheet` + mobile `explore_chat` on the engine; single markdown path | feature-parity |
| 5 | Async/debounced persistence, full history, draft+queue persistence, streaming render coalescing, Retry/offline UX | hardening |

Each phase = one or more conventional commits on a feature branch, merged to
`main` green. Phase 2 does not change any user-visible behavior; phases 3–5
each contain small visible improvements (Retry, offline state, faster
streaming) but no workflow changes.

## Docs

- Update `docs/spec/macos-app.md` chat sections (engine architecture, session
  file v2, Stop/Retry semantics) in the same phase that lands them — the repo
  has drift-guards; `make docs-check` must pass with each merge.
- Update the chat sections of any `docs/explanation/` pages touched.

## Risks & mitigations

- **Migration corrupts user chats** — v1 decode is additive (accept both
  shapes); quarantine behavior unchanged; migration unit tests cover legacy
  ack conventions; v1 files are only rewritten on next save (not rewritten in
  place at launch).
- **Extraction subtly changes turn behavior** — characterization tests exist
  before the move and run against the engine after; phases 2 and 3 are
  separate merges so a regression bisects cleanly.
- **Actor store changes ordering** — forced flush on all user-visible
  boundaries (switch/delete/terminate); debounce tests cover interleavings.
- **`LlmChatSheet` unification regressions** — its server-persisted history
  and polling stay untouched in phase 4; only rendering/Stop/engine plumbing
  change.

## Follow-ups (separate specs)

1. Capability wiring: memory recall surfacing, skills cockpit, hooks/auto-task
   triggers in chat (informed by the capability map of agent/memory/skills/
   hooks infrastructure).
2. Server hardening: `/kb/agent/ask` abort propagation, SSE heartbeat,
   agent-ask streaming, auto-title generation.
3. Chat conveniences: drag-drop/image paste, export, full-text session search,
   duplicate session.
