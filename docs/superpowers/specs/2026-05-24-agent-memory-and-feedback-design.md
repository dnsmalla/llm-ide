# Agent Memory and Feedback — Design Spec

**Date:** 2026-05-24
**Status:** Approved (brainstorming)
**Owner:** dnsmalla

## Goal

Give the user's CLI coding agent (Claude Code / Cursor / Copilot / Gemini) durable, repo-scoped context so it doesn't re-discover the same project facts on every prompt, plus a feedback loop so bugs, repeated frustrations, and regressions are captured systematically.

## Non-Goals

- **Auto-learning memory** (agent writes facts back without user review). Memory is user-curated.
- **Global / cross-repo memory.** Per-repo only. User-level preferences stay in Settings.
- **Per-CLI custom skill content.** Graphify already produces per-CLI skill files via `graphify install`; we just trigger that command.
- **LLM-as-judge regression evaluation.** v1 uses exact-match comparison; LLM-as-judge is a possible follow-up.

## Single Source of Truth

```
<repo>/graphify-out/
    graph.json          ← code + doc nodes (already exists; Graphify owns it)
    memory/             ← curated repo knowledge (this spec adds writes)
        repo.md         ← user-curated facts (architecture, conventions, gotchas)
        q&a/*.md        ← Q&A snapshots saved from repeated-command detection
        bugs/*.md       ← bug reports
```

`<repo>/graphify-out/memory/` is **Graphify's canonical memory dir**. The CLI agent reads this directory via the skill that `graphify install --platform <cli>` installs into the agent's config dir. The app writes files here; the agent reads them.

**The app does NOT inject memory into prompts itself** — Graphify's installed skill handles that across all four CLI tools, so the memory feature works without per-tool integration code.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  <repo>/graphify-out/                                            │
│    graph.json                                                    │
│    memory/  repo.md  q&a/*  bugs/*                               │
└──────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │ writes                                       │ reads via
        │ (this spec)                                  │ installed skill
┌───────┴────────────────────┐               ┌─────────┴────────────┐
│  MeetNotesMac                │               │  Claude Code / Cursor│
│  ┌──────────────────────┐    │               │  / Gemini / Copilot   │
│  │ Graphify view        │    │               │  (active CLI from     │
│  │  · Graphify (code)   │    │               │   Settings)           │
│  │  · InfiniteBrain     │    │               └──────────────────────┘
│  │  · Memory   ← NEW    │    │
│  └──────────────────────┘    │
│  CodeAssistantPanel          │
│   · Report bug ← NEW         │
│   · Repeat-cmd nudge ← NEW   │
│  Regression Check view ← NEW │
└──────────────────────────────┘
```

## Sub-projects

The work decomposes into four sub-projects. Each lands in its own implementation plan + commit set. Each leaves the app in a consistent state — the user can stop after any sub-project.

### A. Memory (foundation)

The minimum viable surface: a tab in Graphify for browsing / editing memory files, plus a one-time "Install agent skill" action that runs `graphify install`.

**UI**

A new third tab in `GraphifyView` next to **Graphify** / **InfiniteBrain**, labelled **Memory**.

```
┌── </>Graphify ── 🧠InfiniteBrain ── 📓Memory ──┐
│ Memory                          [Install skill]│
│ ──────────────────────────────────────────────│
│ Library                Editor / Preview         │
│  ▾ repo.md             ┌────────────────────┐ │
│    overview            │ # InfiniteBrain    │ │
│  ▾ q&a/                │ Swift + SwiftUI    │ │
│     payments.md        │ macOS 14+          │ │
│     deploy.md          │ ...                │ │
│  ▾ bugs/  (3 open)     └────────────────────┘ │
│     2026-05-23-…       Status: graph indexed N │
│                         code + M doc nodes     │
└────────────────────────────────────────────────┘
```

**Files added**

| Path | Purpose |
|---|---|
| `Sources/MeetNotesMac/CodeGraph/MemoryStore.swift` | Read/write the memory dir. Phase A only ships the seed + read methods (`seedIfMissing(in:)`, `loadRepoNotes(at:)`, `saveRepoNotes(at:_:)`, `listBugs(at:)`, `listQA(at:)`). The write methods (`writeBug`, `updateBugStatus`, `writeQA`) are added by phases B and C. |
| `Sources/MeetNotesMac/CodeGraph/GraphifyInstaller.swift` | Wraps `graphify install --platform <cli>`. Maps `AICliTool` → `--platform` arg. Uses the existing `ProcessLauncher` seam for testability. |
| `Sources/MeetNotesMac/Views/CodeGraph/MemoryTabView.swift` | The tab content. Left: tree of memory files. Right: `FileDetailView` (same component the Library uses for markdown editing). |

**Memory dir bootstrap**

On first open of the Memory tab for a given repo, `MemoryStore.seedIfMissing` creates the dir and writes a template `repo.md`:

```markdown
# Project facts

Edit this file with anything the agent should know about this repo —
architecture, conventions, gotchas, where things live. The agent reads
it on every prompt via the Graphify skill.

## Stack

(e.g. Swift 5.9, macOS 14+, SPM)

## Conventions

(e.g. tests live in Tests/<Target>Tests/, services in Sources/<Target>/Services/)

## Gotchas

(things that surprised you the first time)
```

**Install skill action**

Button in the Memory tab header: **"Install skill for Claude Code"** (label varies with `config.activeCLI`). Runs:

```
graphify install --platform <claude|cursor|copilot|gemini>
```

Status line surfaces success / "binary not found" / non-zero exit with stderr tail. Idempotent — re-running it overwrites the existing skill file.

**Code + doc unification badge**

The Memory tab also surfaces a one-line indicator: *"Graph indexed N code · M doc nodes (last run: 2 hours ago)."* Derived from the existing cached `graph.json` via `GraphifyParser` + a count of `file_type=="code"` vs `=="document"` nodes. Reuses existing code paths — no new parser work.

**Out of scope for A**

Writing bugs / Q&A from the app. Those come in B and C. A only seeds and surfaces files.

### B. Bug feedback

A bug-report path in `CodeAssistantPanel` so the user can flag a bad agent answer without leaving the conversation.

**UI**

Each agent response in the chat gains a small "Report this answer" button (alongside copy / regenerate). Click opens `ReportBugSheet`:

```
┌── Report a bug ─────────────────────────────────┐
│ Severity   [Info ▾ | Minor | Major]              │
│                                                  │
│ Prompt (auto-filled, read-only)                  │
│ ┌──────────────────────────────────────────────┐│
│ │ "explain the auth flow"                      ││
│ └──────────────────────────────────────────────┘│
│                                                  │
│ Response (auto-filled, editable)                 │
│ ┌──────────────────────────────────────────────┐│
│ │ <the agent's answer>                         ││
│ └──────────────────────────────────────────────┘│
│                                                  │
│ What went wrong                                  │
│ ┌──────────────────────────────────────────────┐│
│ │ <textarea>                                   ││
│ └──────────────────────────────────────────────┘│
│                                                  │
│ Tags (optional)  #flow #auth                     │
│                                                  │
│         [Cancel]            [Save report]        │
└──────────────────────────────────────────────────┘
```

**On submit:** writes `<repo>/graphify-out/memory/bugs/<ISO8601>-<slug>.md`:

```markdown
---
prompt: |
  <original prompt>
response: |
  <agent response, possibly edited by user>
severity: major
reported_at: 2026-05-23T12:00:00Z
git_head: abc123def
app_version: 0.1.0
agent: claude_code
status: open
tags: [flow, auth]
---

<the user's "what went wrong" notes>
```

**Bug status lifecycle**

`open → acknowledged → fixed → (regression check, in D) → still_fixed | regressed`

The user toggles status manually via a status picker on each bug row in the Memory tab. Phase D consumes `status: fixed` entries.

**Files added**

| Path | Purpose |
|---|---|
| `Sources/MeetNotesMac/Views/CodeAssistant/ReportBugSheet.swift` | The compose sheet. |
| `MemoryStore` | gains `writeBug(at:_:)` and `updateBugStatus(at:_:_:)`. (`listBugs` already exists from A.) |

**Memory-tab affordances added**

- Badge: *"N open bug reports"*.
- Per-bug status picker (open / acknowledged / fixed / wont_fix).

### C. Repeated-command detection

Detect when the user sends the same prompt repeatedly within a session and nudge them to save the most recent answer.

**Detection**

In-memory `[String: Int]` counter inside a new `CodeAssistantSession` service. Each user prompt is normalised (lowercase, collapse whitespace, strip trailing punctuation), hashed (SHA-256, prefix 16 chars), and the count incremented. Threshold: **3 repeats** within the session.

**Session boundary**

- App launch
- Active repo switch (per `linkedCodeRepo` change in ReviewView terms, or per Graphify selectedURL)

When the boundary fires, the counter resets.

**UI**

When threshold hits, a non-blocking banner appears above the message composer:

> You've asked this 3 times — save the answer to memory? **[Save]** **[Dismiss]**

On **Save**, writes `<repo>/graphify-out/memory/q&a/<slug>.md`:

```markdown
---
question: |
  <the prompt>
answer: |
  <the most recent agent response>
saved_at: 2026-05-23T12:00:00Z
ask_count: 3
agent: claude_code
---
```

On **Dismiss**, suppresses the banner for this prompt-hash for the remainder of the session.

**Files added**

| Path | Purpose |
|---|---|
| `Sources/MeetNotesMac/Services/CodeAssistantSession.swift` | Session-scoped counter + dismiss-set. `@Observable`. |
| `MemoryStore` | gains `writeQA(at:_:)`. (`listQA` already exists from A.) |

### D. Regression check on update

Re-run `status: fixed` bug prompts against the current code state and flag any whose answer has drifted.

**Trigger**

1. **Automatic** — once per app launch when `appVersion != lastSeenVersion` (stored in `AppConfig` as `lastSeenAppVersion`). Runs in the background, surfaces a banner if any regressions detected.
2. **Manual** — a "Run regression check now" button on the new Regression view.

**Sidebar entry**

New sidebar section `regression` under **Explore** (next to Graphify). SF Symbol: `arrow.uturn.backward.circle`. Hideable via the existing sidebar visibility setting.

**View**

```
┌── Regression Check ─────────────────────────────┐
│ Active: claude_code · 12 fixed bugs to recheck   │
│                              [Run now]           │
│ ──────────────────────────────────────────────── │
│ ✓ Login flow loops                  unchanged    │
│ ✓ Date formatting wrong             unchanged    │
│ ✗ Auth header missing on retry      REGRESSED    │
│                              [View diff]         │
│ ⋯ Token refresh race                pending      │
└──────────────────────────────────────────────────┘
```

**Comparison**

v1 uses **exact-match comparison** (normalised whitespace) between the original "fixed" answer (saved with the bug) and the current agent response to the same prompt. Pass / fail / pending (still running).

LLM-as-judge ("does the new response still demonstrate the fix?") is explicitly deferred — would need an extra agent invocation per bug and a calibration step. v1 keeps the loop deterministic.

**Agent invocation**

Reuses the existing path `CodeAssistantPanel` uses to invoke the CLI. I'll confirm during plan-writing whether that path is reusable as a service or needs extraction.

**Files added**

| Path | Purpose |
|---|---|
| `Sources/MeetNotesMac/Views/Regression/RegressionView.swift` | The list view + diff sheet. |
| `Sources/MeetNotesMac/Services/RegressionRunner.swift` | Iterates bugs, invokes the CLI, computes verdicts. |

## Data flow (end-to-end)

```
1. User opens Graphify → Memory tab on a repo
2. App seeds graphify-out/memory/ with repo.md template (one-time)
3. User clicks Install skill → `graphify install --platform claude_code`
4. Memory dir is now visible to the agent on every future invocation

5. User chats in CodeAssistantPanel → agent reads code+doc graph
   and memory dir automatically via the skill
6. Agent returns a bad answer → user clicks Report bug
   → writes graphify-out/memory/bugs/<ts>-<slug>.md

7. User asks the same thing 3 times → banner offers to save
   → writes graphify-out/memory/q&a/<slug>.md

8. User upgrades the app → next launch detects version bump
   → RegressionRunner replays each `status:fixed` bug
   → posts a banner if any have regressed
```

## Error handling

| Failure | Surface |
|---|---|
| `graphify` binary missing | "Install Graphify CLI" hint with copyable `uv tool install graphifyy` (same as the existing Graphify-not-installed flow). |
| `graphify install` non-zero exit | Status strip in Memory tab shows the stderr tail + "Retry". |
| Memory dir not writable (read-only volume) | Banner: "Folder is read-only — cannot write memory files." Uses the existing `folderNotWritable` error path. |
| Bug write fails | Inline error in `ReportBugSheet`; keeps the user's input intact so they can retry without losing notes. |
| Regression run timeout | Marks bug as `pending`; user can retry manually. |
| Stale `lastSeenAppVersion` from earlier-version defaults | Treat as a fresh install: no auto-trigger, regression list is empty until bugs accumulate. |

## Testing

- **MemoryStore**: round-trip writes for repo / qa / bugs; status updates; tolerant frontmatter parsing.
- **GraphifyInstaller**: mocked `ProcessLauncher` asserts `graphify install --platform claude` is invoked for each `AICliTool` value.
- **CodeAssistantSession**: increment / threshold / dismiss / reset across simulated session boundaries.
- **ReportBugSheet**: snapshot tests for empty / pre-filled / submitting / error states.
- **RegressionRunner**: in-process with a fake CLI launcher; verifies pass/fail/pending verdicts and that bug status round-trips correctly.

## Risks

| Risk | Mitigation |
|---|---|
| `graphify install` schema changes between graphify versions | Pin the skill format check in `GraphifyInstaller` so a mismatched skill triggers a re-install. |
| Memory files contain sensitive data (PATs, env values) | Memory dir lives under the user's repo and is gitignored by default by `graphify install` (verify in the plan). Add a top-of-file warning in the seeded `repo.md` template. |
| Bug reports grow unbounded | Bugs are dated files; existing patterns (e.g. graphify cache) prove this is fine for the volumes we expect (~dozens, not thousands). |
| RegressionRunner takes minutes for many bugs | Run async, surface progress per-bug, allow cancel. Cap concurrent invocations at 2 to avoid throttling the CLI agent. |
| Repeated-command detection too noisy | Threshold of 3 is conservative; user can dismiss to silence per prompt for the session. If still noisy, raise to 5. |

## Phases (shipping order)

| Phase | Sub-project | Effort | Lands as |
|---|---|---|---|
| A | Memory foundation | ~½ day | One commit set + plan doc |
| B | Bug feedback | ~½ day | One commit set + plan doc, depends on A |
| C | Repeated-command detection | ~½ day | One commit set + plan doc, depends on A |
| D | Regression check | ~1 day | One commit set + plan doc, depends on A + B |

Each phase gets its own implementation plan under `docs/superpowers/plans/`. The user can stop after any phase and the app stays consistent.
