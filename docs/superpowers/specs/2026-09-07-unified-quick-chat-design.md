# Unified quick chat — design

**Date:** 2026-09-07
**Status:** design approved, implementation not started
**Scope:** Mac menu-bar chat, Mac LLM Chat sheet, iPhone global chat

## Problem

The Mac menu-bar chat and the LLM Chat sheet look like the Code Assistant panel's chat and are not. They share `ChatEngine`, but their transport (`Chat/AgentAskTransport.swift`) points at `/kb/agent/ask` — a different product: the **meeting agent**, with its own persona ("You are the user's meeting agent"), an 8,000-char message cap, no tools, no session memory, no project memory, no streaming, and no markdown rendering. The iPhone's global chat calls the same endpoint directly (`Services/MobileControlManager.swift:659`).

The result is a chat that answers from nothing the user has taught the project, in a window that looks like the one that does. Project memory in particular is invisible there: these surfaces pass `agentContext: nil`, so they neither read nor write it.

Goal: these three surfaces become the same kind of chat as the panel — same memory, same tools, same streaming and rendering — while remaining one shared conversation across Mac and phone.

## Decisions

Each of these was an explicit choice, with the alternative recorded because the alternative is what a future reader will be tempted by.

1. **The quick chat follows the active project. With no project open it declines to answer** and says to open one.
   The code pipeline cannot run without a project: `llm_agent/sdk/engine.mjs:690` throws `workspaceRoot is required`. The menu-bar chat is mounted globally (`LlmIdeMacApp.swift:467`) and is reachable with nothing open.
   *Rejected:* falling back to the meeting agent when no project is open. It keeps both pipelines alive and makes the chat silently change character — different memory, different tools, different answer quality — based on app state the user is not thinking about.
   *Rejected:* pinning to a remembered project. Always available, but "which repo am I asking about" becomes invisible, and asking about the wrong one is silent.

2. **The iPhone follows onto the same conversation.** Its chat proxies through the Mac already, so it targets the Mac's active project and shares the transcript with the two Mac surfaces, preserving today's one-conversation-everywhere property.
   *Rejected:* leaving the phone on the meeting agent. The Mac and phone transcripts would silently diverge — a regression against current behaviour.
   *Rejected:* retiring the phone's global chat in favour of its existing Explorer-session chat. Defensible (that surface is strictly more capable) but it removes the zero-setup "just ask" entry point.

3. **The quick chat is its own first-class session**, a new `ChatScope` case persisted in `ChatSessionStore` like any other: listed, deletable, and its session memory dies with it.
   *Rejected:* making it a window onto whichever session the panel shows. Conceptually simplest, but every quick question would land in the user's main working chat.

4. **One engine per conversation, obtained from `ChatEngineRegistry`.**
   `Chat/ChatEngineRegistry.swift:102` — `engine(for scope:api:)` returns *the* engine for a scope, and its own comment notes the mobile bridge's resolver already goes through it.
   *Rejected:* each surface keeping its own `@State ChatEngine` (as `MenuBarChatView` and `LlmChatSheet` do today). With the menu bar, the sheet and the phone all pointed at one session id, that is three engines writing one file — the concurrent-holders class of bug that already caused deleted chats to resurrect via `persistCurrentChat`.

5. **Read-only tools: the quick chat answers, it does not act.**
   Driven by a hard constraint, documented at `Chat/ExplorerMobileEngineResolver.swift:136-141`: a v2 turn can park on an approval, and an off-screen engine has no panel to render the card or post the decision, so the turn hangs until the server's park timeout denies it. The menu-bar popover can be **closed** while the phone drives the same engine — shared is not visible — and the phone has no approval UI at all.
   *Rejected:* full powers. That makes window-level approval surfacing a prerequisite (unbuilt), and even then the phone could not answer.
   *Rejected:* full powers on Mac, read-only from phone. The same conversation would behave differently depending on which device typed into it.

## Architecture

Before:

```
MenuBarChatView ─┐                        ┌─ /kb/agent/ask          (meeting agent:
LlmChatSheet ────┼─ own @State ChatEngine ┤   persona, 8k cap, no tools,
                 │  + AgentAskTransport   │   no memory, buffered)
iPhone ──────────┘  (phone: askAgent directly)
```

After:

```
MenuBarChatView ─┐
LlmChatSheet ────┼─ ChatEngineRegistry.engine(for: .quick) ─── AgentV2Transport / CodeAssist
iPhone ──────────┘         (one engine, one session)              (mode: "ask", read-only)
                                    │
                            ChatSessionStore (.quick scope)
```

The transport is selected by the same `AgentV2Selection` logic the panel uses, so the quick chat inherits engine choice, provider/model handling and the stale-server floor without a second copy of that decision.

## Components

### Server

**New restricted mode `ask`** — one entry in `MODE_CONFIG` (`llm_agent/runtime/mode-personas.mjs:42`):

```js
ask: { persona: '…answer questions about this project; you cannot modify files in this mode…' },
```

Everything needed follows from membership:
- `restrictsTools('ask')` → true (`:77`, `hasOwnProperty` on `MODE_CONFIG`)
- `allowedToolNames('ask')` → `READ_ONLY_TOOL_NAMES` (`:91`), derived from the registry as `kind === 'read'`, so `project_memory`, `find-code`, `read-file`, `list-files`, `search-kb` are in and `run-bash` is out
- `v2ToolPolicyForMode('ask')` hard-disallows the act tools **and** `NATIVE_GATED_TOOLS` (Bash/Edit/Write), so no approval can arise — which is what makes decision 5 enforced rather than merely intended

A new mode is required rather than reusing `review` or `document`: those carry task-specific personas ("give structured code-review feedback", "write documentation"), wrong for general Q&A.

**`/kb/agent/ask` is not removed.** It stops being used by these three surfaces. It remains the meeting-agent endpoint, and it is the only route that accepts image content blocks (`Views/Visual/VisualSourcePanel.swift` notes this; `AgentAskTransport.swift:62` hardcodes `images: []`, which is why no image-to-model path exists anywhere today). Removing it is out of scope and would need an image story on the code pipeline first.

### Mac

| File | Change |
|---|---|
`Models/ChatSession.swift:7` | add `ChatScope.quick` |
`Views/MenuBar/MenuBarChatView.swift` | drop the `@State` engine + `AgentAskTransport`; use `ChatEngineRegistry`; supply `agentContext` from the active project; `mode: "ask"` |
`Views/Shell/LlmChatSheet.swift` | same |
`Views/Shell/LlmChatViewModel.swift` | history comes from `ChatSessionStore` via the engine, not `/kb/agent/ask/history`; `AgentAskHistoryFetching` retires with it |
`Chat/AgentAskTransport.swift` | **delete**, with `AgentAskTransportTests.swift`. Its only two callers are the two surfaces above (verified); nothing else constructs it. The `AgentAskSending` seam goes with it. |
`Services/MobileControlManager.swift:645-680` | the `llmide_chat` arm drives the registry engine instead of `api.askAgent`, mirroring the `explore_chat` arm directly below it |

Markdown rendering, streaming, tool-activity rows and the model picker come from using the panel's engine path — they are not separate work items. (`MenuBarChatView.swift:402` renders a plain `Text` today; it should use `SelfSizingMarkdownView` like the panel.)

### No-project state

One check, one message, three surfaces. `agentContext` is nil exactly when no project is active; the surfaces render "Open a project to chat about your code" instead of a composer, and the phone receives the same sentence as a normal reply (not a `CommandError`, which the phone renders as a failure). This is the only new user-visible state.

## Data flow

A turn from any surface:

1. Surface asks `ChatEngineRegistry.engine(for: .quick, api:)` → the one engine.
2. Engine resolves its transport via `AgentV2Selection` (v2 when the provider is agent-capable, else legacy).
3. `ChatTransportInput` carries `mode: "ask"` and `agentContext` (workspaceRoot + indexedRepos) from the active project.
4. Server runs a restricted turn: read-only tools, project memory reachable via `project_memory`, session memory always-on, `skill_invoked` telemetry recorded per tool call.
5. Engine persists to the `.quick` session file; all three surfaces render from the same engine, so they agree without a sync mechanism.

Session deletion continues to work by inheritance: `ChatEngine.deleteSession` already forgets server-side session memory, so the quick chat gains that for free — satisfying "delete all session memory when the session is deleted" on this surface too.

## Error handling

- **No project** — declines with the message above; no request is sent.
- **Stale server** (no `ask` mode) — an unknown mode falls back to `execute` server-side (`route-modes` behaviour), which would silently grant act tools. The client must therefore gate on the server API version; `SERVER_API_VERSION` gets a bump for the new mode and the Mac checks it before offering the quick chat. **This is the one place where getting it wrong is a safety issue, not a cosmetic one.**
- **Phone with the Mac popover closed** — fine by construction: read-only means no approval can park.
- **Cancellation** — inherited from the engine; note `/kb/agent/ask` had no server-side cancel (`LlmChatViewModel.swift:24-28`), so this is an improvement, not a regression.

## Testing

- `ask` mode: `restrictsTools` true; `allowedToolNames` excludes `run-bash`; `v2ToolPolicyForMode` disallows the native gated tools. The assertion that matters: **an `ask` turn cannot reach an act tool**, so no approval can park.
- Unknown-mode fallback: assert an `ask` request against a server that does not know the mode does not silently become `execute` — i.e. the version gate holds.
- One engine: the menu bar and the sheet resolve to the *same* `ChatEngine` instance for the quick scope (guards decision 4 against regression).
- Session lifecycle: a quick-chat delete forgets its session memory; project memory survives.
- Phone: an `llmide_chat` turn drives the registry engine and its reply appears in the Mac transcript; with no project open the phone gets the decline message as a reply, not an error.
- Memory: a quick-chat turn can reach `project_memory` and its facts are written back — the concrete form of "chat has the same memory as other sessions".

## Out of scope

- Retiring `/kb/agent/ask` or the meeting agent.
- Images on the code pipeline (blocked on there being any image path at all).
- Window-level approval surfacing (Tier 1 item 4) — deliberately unnecessary here because of decision 5.
- Giving the quick chat act tools later. If that is ever wanted, item 4 is its prerequisite, and the phone still could not answer an approval.

## Open decision: what happens when the user switches projects

**This is the one thing the design does not yet settle, and it must be settled before implementation.**

`ChatSession` carries no project id (`Models/ChatSession.swift:22-39` — `id`, `scope`, `title`, timestamps, `messages`, `engine`, and nothing else), and the "current session" pointer is `chat.current.<scope>` (`Chat/ChatEngine+Session.swift:32`) — global, not per-project. A prior audit already logged this as an open defect: chats and SDK sessions resume across projects with a different `cwd`.

Decision 1 makes it acute. A quick chat that explicitly *follows* the active project, on a session with no project identity, means switching projects silently continues the same conversation aimed at a different repo — its earlier turns discussing files that no longer exist, its session memory accumulating across projects.

Options:

- **Add `projectId` to `ChatSession`** (optional, nil = legacy) and scope both the list and the pointer by it. Fixes this properly *and* closes the pre-existing defect for every scope, not just the quick chat. Largest change: touches persistence for all scopes, though as an optional field it needs no migration step.
- **Key only the quick pointer per project** (`chat.current.quick.<projectId>`). No model change, and each project gets its own quick chat — but `list(for:)` cannot filter by project (there is nothing to filter on), so every project's quick chats would appear in one list.
- **One global quick session, with the target project shown in the chat header.** Simplest; makes the mixing visible rather than fixing it. Acceptable only if the quick chat is understood as "ask about whatever I'm working on now", and the transcript being cross-project is a feature rather than a bug.

Recommendation: the first. It is more work than this feature strictly needs, but it is the only option that leaves the codebase better than it found it, and it retires a defect that is already on the books.

## Risks

1. **The unknown-mode fallback is the sharp edge.** A client sending `mode: "ask"` to a server that predates it gets `execute` — full act tools in a window whose approvals may be unrenderable. The version gate is load-bearing; it is the first thing to test and the last thing to remove.
2. **The phone gains a dependency on Mac state.** "No project open" is a reply the phone never had to render before. Inherent to decision 1.
3. **Losing the always-available chat** is a real cost of decision 1. If it turns out to matter more than pipeline unity, the fallback rejected there is the escape hatch — but it should be a deliberate reversal, not a drift.
