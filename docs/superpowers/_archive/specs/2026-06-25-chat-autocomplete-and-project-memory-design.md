# Cursor-like Code Assistant: `/` `@` autocomplete + auto project-memory

**Date:** 2026-06-25
**Surface:** Mac Code Assistant only (`mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`)
**Status:** approved direction (user authorized end-to-end build)

## Goal

Make the Mac Code Assistant chat feel like Cursor:

1. **Autocomplete dropdown** — typing `/` lists invokable slash-commands and (for discovery) skills; typing `@` lists project files to attach as context.
2. **Auto project-memory** — the agent automatically extracts durable, project-scoped facts from each turn and recalls them in future turns, reusing the **existing** Graphify project-memory store rather than a new database.

## Key design decision: reuse the existing project memory

The repo already has a per-project memory pipeline. `renderGraphifyMemory(agentContext, userId)`
([extension/graphkit/memory.mjs](../../../extension/graphkit/memory.mjs)) reads a fixed allow-list of files under
`<repo>/graphify-out/memory/` — gated by the user's repo allow-list — and injects them into the Code Assistant's
system prompt at [route.mjs:133](../../../extension/llm_agent/runtime/route.mjs). The server is always local
(127.0.0.1), so it can both read and write those files.

**Therefore recall is free.** We add one new allow-listed file, `chat-memory.md`, in that same directory. The agent
writes auto-extracted facts there after a turn; the existing reader picks it up next turn. No new table, no new
recall path, **no new `projectId`** — the repo path already in `agentContext` is the project key.

---

## Feature 1 — `/` and `@` autocomplete

### Data sources

| Trigger | Source | Build |
|---|---|---|
| `/` commands (invokable) | new `GET /kb/agent/commands` wrapping `buildPerUserSkillSet(userId).commands` | new endpoint |
| `/` skills (discovery) | existing `GET /kb/agent/catalog` | reuse |
| `@` files | client-side walk of the active repo root | reuse `FileSystemTree` |

Symbols are **out of scope for v1** (no symbol index exists on the Mac side). `@` ships with files only.

### Backend

`GET /kb/agent/commands` → `{ commands: [{ trigger, description, args }] }`, derived from the per-user enabled
command set. Mirrors the `/kb/agent/catalog` skills shape. Args come from each command's `argsSchema`
(keys + required flag only — enough for placeholder hints).

### Mac UI

- A `CompletionController` (ObservableObject) owns: trigger detection, the candidate list, the filter query, and the
  selected index.
- A `CompletionMenu` SwiftUI overlay anchored above the input renders the filtered candidates with keyboard
  selection.
- `ArrowInterceptingTextView` (already exists in `HistoryTextEditor.swift`) is extended so that **while the menu is
  open** it routes ↑/↓/Tab/Enter/Esc to the controller; when the menu is closed, the existing prompt-history recall
  behavior is unchanged. This arbitration is the main integration risk and is called out explicitly.
- **Trigger rules:** `/` opens the command/skill menu only when it is the first non-space character of the input
  (a leading slash command, matching `expandSlashCommand`'s own `trimmed.startsWith('/')`). `@` opens the file menu
  when `@` begins a token (preceded by start-of-line or whitespace).
- **Accept behavior:**
  - command → replace the input with `/<trigger> ` and, if it has required args, insert `key=` placeholders.
  - skill → insert a natural-language mention (skills are agent-selected, not directly invokable); discovery only.
  - file → attach the file as a `CodeAttachment` (reuse `addFile(url:)`), and remove the `@token` from the text.

### Caching

Commands + skills are fetched once per panel appearance (or on first `/`) and cached in the controller; the file
list is walked lazily from the active repo root and cached. No per-keystroke network calls.

---

## Feature 2 — Auto project-memory (reusing Graphify memory)

### Storage

`<repo>/graphify-out/memory/chat-memory.md` — a markdown file, one fact per `- ` bullet line. Capped
(≤ 100 facts / ≤ 8 KB) so it can never blow the prompt budget. Written and read only for repos in the user's
allow-list.

### Shared security gate (refactor)

The path resolution + allow-list + tilde-expansion + `..` rejection logic currently lives inside
`repoMemoryBlock` in `memory.mjs`. Extract it into an exported helper
`resolveAllowedRepoRoot(repoPath, allowedRoots)` (and `buildAllowedRoots(userId)`), used by **both** the reader and
the new writer. This guarantees the writer cannot be a path-traversal hole and removes duplication.

### Recall (read) — already wired

Extend the reader's allow-list to include `chat-memory.md` (rendered under a `### chat-memory.md` sub-section of the
repo's memory block). No other change — it flows through the existing injection at `route.mjs:133`.

### Extract (write)

- New module `extension/llm_agent/runtime/memory-extract.mjs`:
  `extractMemories({ userMessage, reply, existingFacts, runClaude, userId })` → `string[]` of **new** facts.
  - One cheap `runClaude` call (model `LLMIDE_SUMMARIZE_MODEL || default`, `maxTokens` ~512) with a strict prompt:
    "Return a JSON array of 0–N durable, project-specific facts worth remembering for future sessions. Exclude
    anything already in EXISTING. Exclude transient/one-off details. Empty array if nothing." Existing facts are
    passed in so the model dedupes.
  - Robust JSON parse (reuse the `tryParseJSON` pattern); on any parse failure return `[]`.
- New module `extension/graphkit/memory-writer.mjs`: `appendChatMemory({ root, facts })` — merges new facts into
  `chat-memory.md` (dedup by normalized line, enforce caps). `root` is already gated by the caller.
- Hook in `handleCodeAssist`: after `runAgentLoop` returns, **fire-and-forget** (not awaited) an
  `extractAndPersistMemory(...)` that resolves the active repo root via the shared gate, reads existing facts, calls
  the extractor, and appends. Wrapped so it can never throw into or delay the response. Target repo = the active
  project's repo if allow-listed, else the first indexed repo.

### Viewer (trust)

Because capture is automatic, the user needs to see and prune it:

- `GET /kb/agent/project-memory?repo=<homeRelativePath>` → `{ facts: string[] }` (gated; `[]` if not allow-listed).
- `DELETE /kb/agent/project-memory` body `{ repo, fact }` (remove one) or `{ repo, all: true }` (clear) → rewrites
  the file via the gate.
- Mac: a "Project Memory" sheet (reachable from the Code Assistant overflow menu) listing the active repo's facts
  with per-row delete and a clear-all. Read-only otherwise (no manual add in v1 — capture is automatic).

---

## Testing

**Node (runnable locally — native build present):**
- `resolveAllowedRepoRoot` — allow-list gate, tilde expansion, `..` rejection, APFS case-fold (port existing
  memory.mjs test expectations).
- reader includes `chat-memory.md` and respects caps.
- `appendChatMemory` — dedup, cap enforcement, idempotent append.
- `extractMemories` — JSON parse robustness (valid array, garbage, fenced JSON, empty) with a stubbed `runClaude`.
- `GET /kb/agent/commands` shape; `GET/DELETE /kb/agent/project-memory` gate + mutation, with a temp repo dir.
- Regression: existing `graphkit`/memory tests still pass.

**Mac (build-verified):**
- `swift build` green (the panel + new files compile). UI behavior verified by build + code review; no automated UI
  test harness exists for this panel.

## Out of scope (v1)
- `@` symbol mentions (needs a symbol index).
- Manual "remember this" (capture is automatic per the chosen model).
- Extension sidepanel (Mac only).
- Cross-project / global memory (per-project only).

## Sequencing
1. Backend memory (recall + write + extract + viewer endpoints) + tests.
2. Backend `/kb/agent/commands` + test.
3. Mac autocomplete UI.
4. Mac memory viewer.
5. `swift build` + self-review.
