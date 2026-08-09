# Code Assistant Chat — Plan Execution, Command/Diff Blocks & Modes — Design

**Date:** 2026-08-09
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/Sources/LlmIdeMac/Views/CodeAssistant/`, `mac/Sources/LlmIdeMac/Agent/`) + server (`extension/agents/`, `extension/llm_agent/`, `extension/server/ai-routes.mjs`)

## Goal

Make the macOS Code Assistant chat feel like a modern coding-agent chat (Claude Code / Cursor's agent panel): when a task needs multiple steps, show a live plan timeline that updates as steps run; run read-only steps automatically without asking; show command execution and file diffs inline instead of raw text dumps; stop and ask the user if a step fails; and close with a professional summary. On top of that, add explicit **Plan / Review / Document / Execute** modes (with an Auto mode that classifies the request) so each kind of work routes to the pipeline already built for it, and — inside Execute mode — auto-select the matching skill/agent-prompt per step instead of using one generic prompt for everything.

**Confirmed with the user before designing:**
- Target surface is the **macOS app's Code Assistant chat**, not the Chrome extension side panel. "Claude's Chrome extension" / Cursor were cited only as UX references.
- Backend changes to the shared local Node server (`extension/agents/`, `extension/llm_agent/`) are in scope — they're not part of the Chrome extension's own UI, and both the Mac app and the extension already call into this same server.
- Execute mode's step list is generated ad hoc from the prompt each turn (not pulled from the KB plan/Gantt pipeline).
- Tiered approval: read-only tool calls auto-run; writes/bash/git-ops still require the existing tap-to-confirm gate.
- On step failure: stop the run and ask the user — no auto-retry.
- Plan timeline renders as a checklist card pinned to the top of the turn, collapsing to "N/M steps complete" once finished.
- Command output renders as a collapsed monospace block (command + exit status + first lines), with "Show full output" to expand.
- File diffs show a compact inline preview (path, +N/-N, a few changed lines) before opening the existing full-diff sheet.
- Mode selection is an explicit toggle with an Auto fallback that classifies the request and shows the resolved mode as a badge.
- Plan/Review/Document modes route to existing pipelines where they exist, rather than reimplementing them as prompt variants.
- "Auto use different skills" means: classify each Execute-mode step and load the matching skill/agent-prompt guidance (same table as `orchestration_policy.md`) into that step's call.

## Background — current state

The Code Assistant chat already has more agentic UI than the Chrome extension's chat (which is plain markdown Q&A with no tool calls at all — out of scope here). Specifically:

- **Transport**: `POST /code-assist` over SSE (`extension/server/ai-routes.mjs`, `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift`), not the WebSocket described in `docs/explanation/architecture.md` (that doc is stale on this point). Terminal `done` events already carry `pendingTool`, `tasks`, `continueNeeded`, `usage`. Real token streaming (`chunk` events, `beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn`) is **already implemented** per `2026-08-05-code-assistant-streaming-design.md` — confirmed present in `extension/agents/runtime.mjs`, `extension/agents/providers.mjs`, `extension/server/ai-routes.mjs`, and the Mac `CodeAssistantPanel+Session.swift`/`ChatMessageList.swift`. This design builds directly on that streaming turn/event plumbing rather than re-deriving it.
- **State**: split across `CodeAssistantSession` (`Services/CodeAssistantSession.swift`, model/provider selection) and `CodeAssistantAgentState` (`Views/CodeAssistant/CodeAssistantAgentState.swift`, `@Observable`: `pendingTool`, `agentSessionId`, `agentIsAutonomous`, `agentStopRequested`, `agentPendingTasks: [AgentTask]`). The chat transcript (`history: [LlmIdeAPIClient.CodeAssistTurn]`) is plain `@State` on `CodeAssistantPanel`, spread across `CodeAssistantPanel+Session.swift` (764 lines) and `+Agent.swift` (263 lines).
- **Tool approval**: `PendingActionCard.swift` renders a confirm card per tool (`create-issue`, `update-file`, `bash`, `git-op`, etc.) — one gate per turn today, no multi-step sequencing on the client. There's already a narrow read-only auto-run precedent: `shouldAutoRunGitOp` skips the card when a `git-op`'s tier is `.read` (status/log/diff/branch); write/destructive tiers still show the card.
- **Bash**: `Services/BashService.swift` runs `/bin/zsh -c <command>` via `Process`, captures `{exitCode, stdout, stderr, duration}` — but `CodeAssistant+Bash.swift` flattens this into a plain-text turn (`"(bash result - exit code: N)\n<raw output>"`), no truncation, no structure.
- **Diffs**: `UpdateFileSheet.swift` + `UnifiedDiffView.swift` (WKWebView + highlight.js) already provide a full editable diff-review sheet before any file write — this stays as the confirm step; only the pre-tap preview is new.
- **Task/plan concept**: `AgentTask` (`Agent/Models/AgentTypes.swift`) already exists — `{id, title, status: "pending"|"in_progress"|"completed"|"skipped"}`, populated from the server's `tasks` field into `agentPendingTasks`. This is the closest existing thing to a plan timeline, but it's a side array with no "running"/"failed" states and no per-step tool/output linkage.
- **Multi-step sequencing**: the server's agent loop (`extension/llm_agent/runtime/loop.mjs`, `MAX_ITERATIONS`) already sequences multiple tool calls server-side; the Mac client just surfaces one `pendingTool` at a time via `continueNeeded` and waits for a manual/automatic follow-up round-trip.
- **File size**: `CodeAssistantPanel+Session.swift` (764 lines) and `ChatComposer.swift` (782 lines) are already over the 500-line project limit. New work lands in new files, not further growth of these two.
- **Modes/skills**: no mode concept exists in Code Assistant today. `orchestration_policy.md` already defines a task-type → subagent/skill routing table (feature/bugfix, review, debug, refactor, docs, …) for this Claude Code session, but nothing wires that table into the server-side agent loop that drives Code Assistant.

## Decisions (from brainstorming)

- **Approach**: a new, focused `PlanTimelineStore` (single-responsibility `ObservableObject`: track steps, decide auto-run vs. gate, stop on failure) rather than folding orchestration logic into the already-oversized `CodeAssistantAgentState`/`+Session.swift`, and rather than a full state-consolidation rewrite (flagged as separate future cleanup, out of scope here).
- **Auto-run classifier**: generalize `shouldAutoRunGitOp` into `shouldAutoRun(pendingTool:) -> Bool` — true for read-only tools (`list-issues`, read-tier `git-op`, search/view calls), false for anything mutating (`update-file`, `bash`, write-tier `git-op`, `create-issue`, `comment-issue`, `update-issue`, `create-branch`, `create-pr`/`create-gitlab-mr`, `trigger-review-code`).
- **Failure handling**: no auto-retry. First failure stops the run, marks the step ✗, and posts a message asking the user how to proceed.
- **Iteration cap**: rely on the server's existing `MAX_ITERATIONS` in `loop.mjs`; no new client-side cap.
- **Summary**: no separate summarization call — adjust the agent-loop system prompt to instruct Claude to keep going through read-only steps without asking, then close with a concise professional summary (what changed, what ran, results, follow-ups).
- **Phasing**: Phase 1 (plan timeline, command blocks, diff previews, auto-continue, stop-on-failure) is independently shippable and is the original ask. Phase 2 (mode picker, auto-classification, Plan/Review/Document routing, per-step skill auto-routing) builds on Phase 1's step machinery.

## Architecture — Phase 1 (Execute-mode upgrade)

```
Mac: ChatComposer.submit() → runTurn() → codeAssistRoundTrip()
   │  SSE: chunk* → done{pendingTool, tasks, continueNeeded}   [existing, per streaming design]
   ▼
PlanTimelineStore.start(tasks)   [NEW]
   │  renders PlanTimelineCard pinned to the turn: ○ pending / ⟳ running / ✓ done / ✗ failed
   ▼
For the current step's pendingTool:
   │
   ├─ shouldAutoRun(pendingTool) == true   [NEW, generalizes shouldAutoRunGitOp]
   │     → execute immediately (existing tool-dispatch code path, same as tapping Approve)
   │     → PlanTimelineStore.complete(step, summary)
   │     → append synthetic result turn → sendFollowup()  [existing mechanism, called automatically]
   │     → loop continues to next step without user input
   │
   └─ shouldAutoRun(pendingTool) == false
         → PendingActionCard shown as today (pause point)
         → for update-file: compact inline diff preview shown first (path, +N/-N, few lines)
              → tap opens existing UpdateFileSheet, unchanged
         → for bash: on approval, BashService.execute() runs, result now structured
              → CommandOutputView renders collapsed block; PlanTimelineStore.complete(step, summary)
         → user Approve/Reject resumes or ends the loop

On step failure (non-zero exit, tool error, HTTP error):
   → PlanTimelineStore.fail(step, error)
   → loop stops (no sendFollowup call)
   → assistant message: what failed + ask how to proceed

On continueNeeded == false (all steps done):
   → PlanTimelineStore collapses to "N/M steps complete"
   → final assistant turn (already streamed) serves as the professional summary,
     per the adjusted loop.mjs prompt
```

## Components — Phase 1

**Server (`extension/`):**
- `llm_agent/runtime/loop.mjs` — prompt adjustment only: instruct the model to (a) execute read-only steps in sequence without pausing to ask, (b) stop and explain if a step's result indicates failure rather than continuing past it, (c) end with a concise, professional summary of changes/commands/results once the goal is reached or blocked. No new endpoint; `tasks`/`continueNeeded`/`pendingTool` shapes are unchanged.
- `agents/*` bash-result shape — extend the result payload passed back into the turn/history with structured fields (`command`, `exitCode`, `stdout`, `stderr`, `durationMs`) instead of a single flattened string, so the Mac client can render `CommandOutputView` instead of raw text. This is additive to the existing `tasks`/`pendingTool` wire shape.

**Mac (`mac/Sources/LlmIdeMac/`):**
- `Agent/Models/AgentTypes.swift` — extend `AgentTask` with a real status enum (`pending/running/done/failed/skipped`, superseding the current string status) plus optional `toolName`, `summary`, `error`.
- `Agent/PlanTimelineStore.swift` (**new**) — `ObservableObject` owning `[AgentTask]`, `isRunning`, `failureMessage`; methods `start(tasks:)`, `markRunning(_:)`, `complete(_:summary:)`, `fail(_:error:)`, `reset()`. No view code, no networking — unit-testable in isolation.
- `Agent/CodeAssistant+AutoRun.swift` (**new**) — `shouldAutoRun(pendingTool:) -> Bool`, the generalized classifier described above; replaces the narrower `shouldAutoRunGitOp` call sites.
- `Views/CodeAssistant/PlanTimelineCard.swift` (**new**) — pure presentational view, pinned at the top of the active turn in `ChatMessageList.swift` when `PlanTimelineStore.tasks` is non-empty; renders the ○/⟳/✓/✗ checklist and the collapsed "N/M steps complete" summary state.
- `Views/CodeAssistant/CommandOutputView.swift` (**new**) — renders `$ <command>`, exit status glyph, duration, first ~6 lines of combined stdout/stderr, and a "Show full output" disclosure for the rest.
- `Views/CodeAssistant/ChatMessageList.swift` — where `update-file` appears, add a small diff-preview view (path, `+N/-N`, first few changed lines, reusing `UnifiedDiffView`'s existing diff-parsing rather than reimplementing it) before the tap target that opens `UpdateFileSheet`.
- `CodeAssistant+Bash.swift` — consume the server's structured bash-result fields instead of building a flattened string, and drive `PlanTimelineStore` transitions from the result.

## Architecture — Phase 2 (modes + skill auto-routing)

```
ChatComposer: mode picker (Auto | Plan | Review | Document | Execute)   [NEW]
   │  selected mode sent as `mode` field on POST /code-assist
   ▼
Server /code-assist dispatch                                            [NEW routing]
   │
   ├─ mode == "auto" → classify request against orchestration_policy.md's
   │                    task-type table → resolves to one of the four modes,
   │                    resolved mode returned in the SSE stream for the
   │                    client to render as a badge on the turn
   │
   ├─ mode == "plan"     → existing /kb/generate-plan pipeline (KB-grounded,
   │                        risk-annotated) → rendered read-only in chat,
   │                        no tool execution, no timeline card
   │                        (distinct from Execute mode's own ad-hoc step list)
   │
   ├─ mode == "review"   → existing review/guardrail pipeline already backing
   │                        `trigger-review-code` → findings rendered in chat,
   │                        never writes files
   │
   ├─ mode == "document" → new lightweight docs-writing skill/prompt
   │                        (reuses the `docs_writer` role from
   │                        orchestration_policy.md) → doc text in chat with
   │                        an option to save under docs/
   │
   └─ mode == "execute"  → Phase 1 flow, PLUS per-step skill auto-routing:
                            before each step's model call, classify the step
                            (bugfix/feature/refactor/debug/docs/...) using
                            the same orchestration_policy.md table, and load
                            the matching skill's guidance (.skills/ or
                            extension/agents/) into that step's prompt
```

## Components — Phase 2

**Server (`extension/`):**
- `server/ai-routes.mjs` — `/code-assist` accepts a `mode` field; when `"auto"`, runs a lightweight classification pass (reusing the existing model-call plumbing, not a new provider integration) before dispatch and includes the resolved mode in the SSE stream.
- Plan/Review dispatch — route to the existing `/kb/generate-plan` and review/guardrail pipelines respectively; no reimplementation of their logic, only the routing glue and response shaping needed to render their output as a chat turn.
- `agents/docs-writer` (**new**, small skill/prompt file, naming/location to be finalized during planning) — Document mode's prompt, modeled on the `docs_writer` role already named in `orchestration_policy.md`.
- `llm_agent/runtime/loop.mjs` — per-step classification: reuse the task-type table from `orchestration_policy.md`; load the matching file from `.skills/` (e.g. `systematic-debugging`, `test-driven-development`) or `extension/agents/` and inject its guidance into that step's prompt. Classification and injection happen once per step, inside the existing loop — no new wire event needed since this only affects prompt construction, not the client-visible shape.

**Mac (`mac/Sources/LlmIdeMac/`):**
- `Views/CodeAssistant/ChatComposer.swift` — add a segmented mode control (`Auto` default). Selected mode is sent with the next turn's request.
- `Views/CodeAssistant/ChatMessageList.swift` (or a small new badge view) — render the resolved mode as a chip on the turn when the server returns one (relevant mainly for Auto).
- Plan/Review/Document mode responses render as regular chat content (markdown), reusing existing turn rendering — no new transcript machinery needed since these modes don't execute tools or produce a timeline.

## Data model changes

```swift
// Agent/Models/AgentTypes.swift
enum AgentTaskStatus: String, Codable {
    case pending, running, done, failed, skipped
}

struct AgentTask: Identifiable, Codable {
    let id: String
    var title: String
    var status: AgentTaskStatus
    var toolName: String?
    var summary: String?
    var error: String?
}
```

```javascript
// extension/agents/* bash result shape (illustrative)
{
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  durationMs: number,
}
```

## Error handling

- **Step failure** (non-zero bash exit, tool exception, HTTP error): `PlanTimelineStore.fail(step, error)`, run stops, no auto-retry, assistant message explains the failure and asks how to proceed — matches the existing "never worse than today" bar, since today's flow already stops at one tool call per turn.
- **Provider/classification failure in Auto mode** (Phase 2): fall back to Execute mode rather than blocking the turn — classification is an optimization, not a gate.
- **Session switch mid-run**: `PlanTimelineStore.reset()` alongside the existing `resetActiveTurnState()` cancellation, so no stray timeline/step state leaks into a new session (same pattern the streaming design already established for in-flight turns).
- **Read-only auto-run tool itself errors** (e.g. a `list-issues` call fails): treated as a step failure like any other — auto-run only changes whether the user is asked *before* running, not whether failures are surfaced.

## Testing

- **Mac**: swift-testing cases for `PlanTimelineStore` (status transitions, stop-on-failure, reset) and `shouldAutoRun` (table of tool name/tier → expected bool). No XCTest UI automation available in this environment (established limitation, per `2026-08-05-code-assistant-streaming-design.md`) — new views verified via `swift build` + manual exercise against a running local server: a multi-step task with a mix of auto-run and gated steps, a step that fails mid-run, a bash command producing long output (collapse/expand), and a file edit (inline preview → full sheet → Apply).
- **Server**: unit tests for the bash-result structuring, for the Phase 2 mode classifier (sample prompts → expected mode), and for per-step skill selection (sample step titles → expected skill file chosen) — mirroring the task-type table in `orchestration_policy.md` as the source of truth so the two don't drift.
- Regression check: existing single-tool-call-per-turn flows (issue creation, PR creation, etc.) continue to work unchanged when their tool type is correctly classified as "gate" by `shouldAutoRun`.

## Out of scope

- Any change to the Chrome extension's side panel chat — it remains plain markdown Q&A; this design only touches the macOS app and the shared local server both surfaces call into.
- The KB-grounded Plan/Gantt tab itself — Phase 2's Plan mode calls its existing pipeline but does not modify it.
- Full consolidation of `CodeAssistantSession`/`CodeAssistantAgentState`/transcript `@State` into one ViewModel, and splitting the already-oversized `+Session.swift`/`ChatComposer.swift` — flagged as valuable future cleanup, not bundled into this feature.
- Auto-retry on step failure — explicitly decided against; first failure always stops and asks.
- A new client-side iteration cap — the server's existing `MAX_ITERATIONS` is relied on as-is.
