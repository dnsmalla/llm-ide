# Claude Linker — design

Date: 2026-09-02
Status: approved (approach A, "both sides + neutral boundary")

## Problem

An update to the Claude Agent SDK / Claude CLI (flags, stream-json, tool
names, model ids) today touches ~24 non-test files across the Node server
and the Mac app. The goal is a *linker*: one clearly bounded layer per
side that owns all Claude-specific knowledge, so an SDK update edits only
the linker.

## Inventory (as reviewed 2026-09-02)

- The SDK package (`@anthropic-ai/claude-agent-sdk` 0.3.245) is imported
  only inside `extension/llm_agent/sdk/` — that boundary is already
  intact but unenforced and undocumented.
- CLI argv building / stream-json parsing is already concentrated in
  `extension/providers/` (providers.mjs, runtime.mjs, web-client.mjs).
- Leaks OUTSIDE those layers (server): `routes/agent-v2.mjs` reads the
  SDK's on-disk transcript layout (`CLAUDE_CONFIG_DIR`, `~/.claude/
  projects/…`) and hardcodes `provider: 'anthropic'` for metering.
- Leaks (Mac): SDK wire vocabulary in `Views/CodeAssistant/Chat/
  AgentV2Event.swift` + `AgentV2Transport.swift`; SDK tool-name verb
  table in `LlmIdeAPIClient+CodeAssist.swift`; `"Edit"`/`"Write"`
  switches in `ToolApprovalCard.swift`; Claude CLI flags duplicated in
  `AutoCodeUpdateService+CLI.swift` and `CodeWorkflowService.swift`
  (`--permission-mode acceptEdits`, `-p`).

## Design

### Wire stays frozen

The Mac↔server wire format (SSE event vocabulary, decision bodies) is
OURS — defined by `llm_agent/sdk/events.mjs`, versioned by
`SERVER_API_VERSION`. It does not change in this refactor. The linker
boundary is drawn so both endpoints of that vocabulary live inside the
two linkers; an SDK change is absorbed server-side and, at worst,
touches only the Mac linker.

### Server linker = `extension/llm_agent/sdk/` + `extension/providers/`

1. New `llm_agent/sdk/transcripts.mjs`: `deleteSdkTranscripts(userId,
   sdkSessionId)` moved verbatim from `routes/agent-v2.mjs` — the SDK's
   transcript disk layout is linker knowledge.
2. `llm_agent/sdk/engine.mjs` exports `AGENT_SDK_PROVIDER = 'anthropic'`;
   `routes/agent-v2.mjs` meters with it instead of a literal.
3. ESLint ratchet: `@anthropic-ai/claude-agent-sdk` may be imported only
   under `llm_agent/sdk/` (tests exempt). Enforced in
   `extension/eslint.config.mjs` alongside the layer rules.

### Mac linker = `mac/Sources/LlmIdeMac/ClaudeLink/`

New directory holding every file whose content changes when the SDK
does; existing types keep their names (no wire or API change):

- `AgentV2Event.swift` (moved) — SDK event vocabulary decode.
- `AgentV2Transport.swift` (moved) — v2 request assembly + event→result
  mapping.
- `ClaudeToolPresentation.swift` (new) — the tool-name knowledge:
  `normalizedToolName` / verb table / progress label (from
  `LlmIdeAPIClient+CodeAssist.swift`) and approval title / icon /
  always-allow label (from `ToolApprovalCard.swift`). The old statics
  remain as one-line delegating shims so call sites and tests are
  untouched and the public surface is stable.
- `ClaudeCLI.swift` (new) — CLI invocation knowledge: executable name,
  `-p` prompt args, `--permission-mode acceptEdits`, fallback model ids,
  retired-model migration rows, provider id, vault key. (`--model` stays
  in `AutoCodeUpdateService.modelArgs` — it is shared by codex/gemini,
  not Claude-specific.) `AICliTool`'s `.claudeCode`
  cases delegate here; `AutoCodeUpdateService+CLI` and
  `CodeWorkflowService` use a new `AICliTool.unattendedPermissionArgs`
  instead of inlining the flag (removes the 3-site duplication).
  `CodeWorkflowService` also switches its hardcoded `-p` to
  `nonInteractivePromptArgs` (fixes a latent bug: it passed `-p` to
  non-Claude CLIs).

### Documentation

`docs/explanation/claude-linker.md`: the boundary definition and an
**SDK update playbook** — the ordered file list to touch and tests to
run on the next SDK bump. `CLAUDE.md` "Starting Points" gains one line
pointing at it.

## Out of scope (deliberate)

- No wire format change, no `SERVER_API_VERSION` bump.
- `runClaude()`/`runClaudeStream()` keep their names — they ARE the
  linker's public API; renaming 8+ call sites adds churn, not safety.
- `AgentV2ApprovalState.swift` stays put (UI state machine, not
  vocabulary).
- Neutralizing approval-args shapes on the wire (Edit's
  `oldString`/`newString` etc.) — possible follow-up; both endpoints of
  that shape now live inside linkers, which already meets the goal.

## Verification

`cd extension && npm test && npm run lint`; `cd mac && swift build`
(+ `swift test` where available). Behavior-preserving refactor — all
existing tests must pass unmodified.
