# Chat + Claude-linker restructure

Status: proposed · Date: 2026-09-10 · Scope: `mac/Sources/LlmIdeMac`, `extension/llm_agent`, `extension/providers`

## 1. Problem

Chat is the product's largest subsystem — roughly 14,000 lines — and it is the
only major feature that never received the repo's own folder convention. Three
features (`Graph/`, `AutoTask/`, `LoopEngine/`) are self-contained vertical
slices. Chat is spread across five locations:

| Piece | Location | Lines |
|---|---|---|
| Engine | `Chat/` | 4357 |
| Panel UI | `Views/CodeAssistant/` | 7092 |
| Menu-bar UI | `Views/MenuBar/MenuBarChatView.swift` | 907 |
| Sheet UI | `Views/Shell/LlmChat*.swift` | 611 |
| Services | `Services/Chat*.swift` | 351 |
| Session model | `Models/ChatSession.swift` | 148 |
| Mac linker | `ClaudeLink/` | 801 |

Four audits established the following. Every claim below was verified directly
against the code or the database, not inferred.

### 1.1 Scattering has a measurable cost

`Package.swift` excludes features by path for the `build-mac-lite`,
`build-mac-min` and `build-mac-mobile-only` variants. A cohesive folder costs one line
(`libExcludes.append("Graph")`, `Package.swift:45`). The scattered `mobile_sync`
feature costs 14 file-level excludes, a nested conditional, and a dedupe loop
(`Package.swift:138-188`), with a comment apologising for the arrangement.

The 187 Mac test files live in one flat directory, which is why excluding
AutoTask's tests requires 44 hard-coded filenames (`Package.swift:89-133`),
Graph's 6 and Mobile's 12.

Two clarifications, so the case is not overstated:

- **Chat itself is never excluded.** `agent_chat` is not in the excludable key
  list (`Package.swift:21-24`); every variant including `build-mac-min` compiles
  it. Consolidating Chat therefore adds *no* exclusion entry and removes none.
  What it does buy is comprehension, and — usefully — it means **Phase 1 carries
  no `Package.swift` exclusion risk for Chat at all**.
- The exclusion pain is real but belongs to `mobile_sync`, one of whose 14
  scattered file-level excludes is `Chat/ExplorerMobileEngineResolver.swift`
  (`Package.swift:161`). Chat's reorganisation removes one line there; the
  remaining 13 are Mobile's own scattering and out of scope.

The measurable `Package.swift` win in this work is the **test** side: foldering
tests per feature collapses 60+ bare filenames to folder entries.

### 1.2 The engine is a God object, and its split made encapsulation worse

`Chat/ChatEngine.swift` is 1189 lines of which only 418 are code (59% comment).
It carries six responsibilities: chat state, turn lifecycle, SSE chunk
coalescing, persistence debouncing, a 17-closure dependency-injection panel, and
a plan-execution state machine.

It was previously split into six `ChatEngine+*.swift` extensions along existing
`// MARK:` boundaries rather than by concern. The file documents the cost at
`ChatEngine.swift:30-33`: because extensions cannot hold stored properties, all
state was widened from `private(set)` to internal. The split reduced
encapsulation to buy line count. A seventh extension lives under `Views/`
(`Views/CodeAssistant/Chat/AgentV2ApprovalState.swift:72`).

Comment-to-code inversion is measured, not impressionistic:

| File | Total | Code | Comment |
|---|---|---|---|
| `ChatEngine.swift` | 1189 | 418 | 59% |
| `ChatEngine+Session.swift` | 661 | 249 | 58% |
| `ChatEngine+ExternalTurn.swift` | 327 | 144 | 54% |

Much of that comment is bug archaeology, which signals invariants the structure
cannot express.

### 1.3 Duplication is documented rather than removed

- Three transcript renderers for one `[ChatMessage]`: `ChatMessageList.turnView`,
  `LlmChatSheet.bubble`, `MenuBarChatView.messageRow`.
- The approval-card block is copy-pasted three times. Two copies carry the
  comment "See `ChatMessageList`'s identical block"
  (`LlmChatSheet.swift:238`, `MenuBarChatView.swift:477`).
- Two turn drivers: `runTurn` and `performExternalTurn`, the latter described in
  its own header as "a 1:1 mirror of `runTurn`'s own body".
- Two engine caches with independent LRU logic: `ChatEngineRegistry.background`
  and `ExplorerMobileEngineResolver.offScreen`.
- Two tool-presentation tables (see 1.5).

`ChatEngine.bubbleHeights` (`ChatEngine.swift:176`) is view geometry stored on
the engine and written by two views (`ChatMessageList.swift:673`,
`MenuBarChatView.swift:550`). When the sheet and menu bar are both open on the
`.quick` engine they write the same dictionary.

### 1.4 Boundaries hold only where a machine checks them

This is the central finding. The server's Claude-linker rule is enforced by an
ESLint ratchet (`extension/eslint.config.mjs:33-49`) and has **zero
violations** — only three files import `@anthropic-ai/claude-agent-sdk`, all
inside `llm_agent/sdk/`.

Every boundary maintained by documentation alone has drifted:

**The wire vocabulary has five emitters across four directories.**
`docs/explanation/claude-linker.md` states that `llm_agent/sdk/events.mjs`
defines it. Two emitters are inside the linker (`events.mjs`, `engine.mjs`);
three are outside (`llm_agent/runtime/task-session-context.mjs:53`,
`routes/agent-v2.mjs:257,340,350,368`, `server/ai-routes.mjs:180,301,559,561`).

**Three Anthropic model lists disagree, and the server's default is a model the
Mac treats as retired.**

| Source | Value |
|---|---|
| `ClaudeLink/ClaudeCLI.swift:36-42` | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-4-8` |
| `extension/kb/usage.mjs:28-34` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` |
| `extension/providers/runtime.mjs:48` | `DEFAULT_MODEL = 'claude-sonnet-4-6'` |

`ClaudeCLI.retiredModelIds` maps `claude-sonnet-4-6 → claude-sonnet-5` and
`claude-haiku-4-5-20251001 → claude-haiku-4-5`. Two of the server's three chain
models are ids the Mac coerces away, including the server default.

**Comment/code drift of 3× on the approval timeout.**
`DEFAULT_TIMEOUT_MS = 900_000` (`decisions.mjs:19`) while `engine.mjs:640`,
`engine.mjs:888`, `registry.mjs:172`, `registry.mjs:197` and
`ai-routes.mjs:470` all say 300 s. A stuck approval parks a turn for 15 minutes.

**Sync bookkeeping has three disagreeing SHAs.** Root `.skills-lock`
(`64a1932`), `extension/.skills-lock` (`c69b258`), submodule HEAD (`c60fb77`).
The gitlink matches HEAD; both lock files are stale, and `extension/.skills-lock`
has no writer anywhere in the repo. The submodule is also dirty.

### 1.5 The v2 transport discards data the server already sends

Confirmed at `mac/Sources/LlmIdeMac/ClaudeLink/AgentV2Transport.swift:265-280`:
`.toolArgsDelta` and `.usage` are `break`-ed, and `.toolResult` keeps only the
tool name, dropping `payload.text`, `isError` and `truncated`.

| Data | Legacy engine | v2 engine |
|---|---|---|
| Salient tool argument | shown (`detail`) | **nil** — `AgentV2Transport.swift:338` |
| Full tool args | never sent | sent, **dropped** |
| Tool result text | never sent | sent (≤20k), **dropped** |
| Tool error flag | n/a | sent, **dropped** |
| Token usage | n/a | sent, **dropped** |

The user sees "Reading…" with no filename on v2 where legacy shows "Reading
UpdateFileSheet.swift". **This is not a patchable bug.** The shared
`ChatTransport` protocol carries only `AgentProgress` + `String` chunks, and
`ChatMessage.ToolStep` has fields for `label`/`tool` only. There is nowhere to
put the data. Fixing it *is* structural work, which is why it is sequenced after
the restructure rather than before it.

A second tool table compounds this: `Chat/ChatMessage.swift:45-59` maps
tool → SF Symbol keyed on **raw** kebab-case names, bypassing
`ClaudeToolPresentation.normalizedToolName`. Every SDK built-in (`Read`, `Bash`,
`Edit`) renders as a generic wrench while the verb beside it correctly reads
"Running".

### 1.6 Three words each name several unrelated things

**"Memory" — 13 distinct stores.** The same extracted facts are written twice
(`memory-persist.mjs:92` → `chat-memory.md`, `:100` → `session_memory`) and
injected into the *same prompt* twice (`route.mjs:272` and `route.mjs:304`).
Conversation content exists in three places at once for a v2 chat. Swift's
`Services/Memory/` contains only the fault/Q&A archive — none of the distilled
facts, history, graph artifacts, or FTS index.

Verified row counts in `kb/data.db`:

| Table | Rows | Status |
|---|---|---|
| `search` / `sources` | 9162 / 9158 | live, but unreachable from chat — planner only |
| `session_memory` | 55 | live |
| `agent_sessions` | 5 | live |
| `chat_sessions` / `chat_messages` | 0 / 0 | dead, self-documented as unused |
| `agent_ask_messages` | 0 | dead |

**"Agent" — four unrelated concepts.** `extension/agents/` (server pipeline
stages), `mac/.../Agent/` (a write-tool proposal *UI*, no runtime),
`ask-internal`/`ask-subagent` (nested loops), and `.claude/agents/` (Claude Code
developer tooling, symlinked to a *codex* directory). `planner` exists twice with
no relationship.

**"Skill" — four concepts:** agent tool definitions, library skills, pipeline
skills, and `.claude/skills/`.

### 1.7 Dead surface, verified

- `MemoryStore.writeFault` has **zero production callers** — only three test call
  sites. Yet `RegressionRunner` lists faults, exports them to CSV, and the server
  injects the newest 8 into every agent prompt. A read chain with no writer.
- `MemoryStore.swift:7` advertises `loadRepoNotes` / `saveRepoNotes`. Neither
  exists anywhere in `mac/Sources`.
- `session-tasks.clearSession` has zero callers; a deleted chat's tasks stay
  resident until server restart.
- Five of thirteen `PendingToolKind` cases (`AgentTypes.swift:117-122`) name
  tools with no server-side definition.
- `ClaudeToolPresentation.verb` has cases for `list-issues`/`get-issue` (tools
  that do not exist) and `task`/`todowrite` (always denied by `canUseTool`).

## 2. The verification constraint

`xcode-select -p` is `/Library/Developer/CommandLineTools`. There is no full
Xcode, so `XCTest.framework` is absent and **154 of 187 Mac test files cannot run
on this machine**. Only 32 use swift-testing. mac-CI is additionally red at the
checkout step.

The repo already knows this: `test-mac` guards `swift test` behind
`ifeq ($(HAS_XCTEST),1)` and otherwise only builds the product.

`make regression` is therefore **four builds** plus the graph gates:

```
regression: graph-kit-checkout test-mac build-mac-lite build-mac-min \
            build-mac-mobile-only graph-gates
```

- `test-mac` — full `swift build --product LlmIdeMac` (+ `swift test` only where XCTest exists)
- `build-mac-lite` — `LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync`
- `build-mac-min` — `LLMIDE_FEATURES=agent_chat`
- `build-mac-mobile-only` — `LLMIDE_FEATURES=agent_chat,mobile_sync`

**Crucially, the repo has already solved the "no XCTest" problem, and the
solution applies directly to this work.** `graph-gates` runs assertions as
SwiftPM *executable products* — `swift run -c release graph-layout-lab` and
`graph-engine-lab` — precisely because, as the Makefile comment says, they must
"run where `swift test` cannot (a Command-Line-Tools-only toolchain has no
XCTest)". Alongside them, `scripts/conformance-memory.mjs` runs **both** the
Swift and TypeScript tracks over one corpus and **diffs the two outputs**.

That comment also records the lesson this design must inherit:

> schema/fixtures only prove a graph decodes, never that the two engines AGREE,
> which is how the port silently dropped graph-only/related-modules […]

and:

> a gate nothing runs is a gate in name only

So a schema plus fixtures for the agent/v2 wire is **not sufficient** — it would
prove Swift decodes a fixture, not that Swift and Node share one vocabulary. §4.2
is revised accordingly: the wire boundary gets a *conformance runner* that diffs
both sides, wired into `make regression`.

Server-side is healthier: `npm test` and the ESLint ratchet both run. Note
`make lint` is **Node-only** (`cd extension && npm run lint`); neither SwiftLint
nor swift-format is installed, so no Swift-side rule can be enforced by a
linter — Swift-side checks must be executable gates.

## 3. Goals and non-goals

**Goals**

1. Chat becomes one vertical slice matching the `Graph/AutoTask/LoopEngine`
   convention (each of which already nests its own `Models/Services/Views`, so
   `Chat/Views/` is consistent with precedent, not a new idea). Tests are
   foldered to match, collapsing 60+ bare filenames in `Package.swift`.
2. No file over ~400 lines carries more than one responsibility.
3. Each duplicated concept has exactly one implementation.
4. Every boundary that matters is machine-checked, not documented.
5. The v2 tool-data loss is fixed.
6. "Memory", "agent" and "skill" each name one thing, or their variants are
   explicitly disambiguated in code and docs.
7. Provably dead Swift/JS code is deleted.

**Non-goals**

- Re-architecting `Views/` as a whole (183 files) — out of scope.
- Dropping the three empty DB tables. Migrations here are append-only and
  immutable; removal costs a new migration for zero runtime benefit. They will be
  marked deprecated instead.
- Changing chat behaviour except where §5 Phase 4 states it explicitly.
- Unifying the legacy and v2 engines. Both stay live; v1 is the unconditional
  path for mobile, non-Anthropic providers, and toggle-off users.

## 4. Approach: enforced boundaries

Rejected alternatives:

- **Convention only** — vertical slices and splits with boundaries left
  documented. Rejected because §1.4 shows documented boundaries in this
  repository reliably decay, while the one lint-enforced boundary has zero
  violations.
- **Full clean architecture** — layered Domain/Application/Infrastructure across
  the app. Rejected: high risk with no test gate, and it discards the working
  `Graph/AutoTask/LoopEngine` convention this repo already proves out.

The chosen approach pairs every structural boundary with a mechanical check.

### 4.1 Target Mac structure

```
mac/Sources/LlmIdeMac/Chat/
├── Models/         ChatMessage, ChatSession, ChatScope, ToolStep, ToolResultPayload
├── Engine/         ChatEngine (state + turn lifecycle)
│                   ChatStreamBuffer        ← extracted chunk coalescing
│                   ChatPersistenceScheduler← extracted debounce + store I/O
│                   ChatEngineHooks         ← 17 loose closures → one injectable value
│                   PlanExecutionTracker    ← extracted plan state machine
│                   ChatTurnRunner          ← runTurn / sendFollowup / externalTurn, one driver
├── Session/        ChatSessionStore, SessionLifecycle, QuickChatSessionPointer
├── Transport/      ChatTransport, CodeAssistTransport, AgentV2Selection (policy only)
├── Services/       ChatSlashCommands, ChatVoiceState, ChatEngineRegistry
└── Views/
    ├── Panel/      CodeAssistantPanel + its extensions
    ├── Quick/      QuickChatSurface (one implementation; sheet and menu bar
    │               become thin chromes over it)
    └── Shared/     ApprovalCardSlot, ChatTurnView, ToolApprovalCard,
                    ApprovalQuestionCard, transcript primitives
```

`AgentV2EngineTransport` moves from `Chat/AgentV2Selection.swift` into
`ClaudeLink/`, next to `AgentV2Transport`, leaving `AgentV2Selection` as pure
policy.

Tests move into `Tests/LlmIdeMacTests/Chat/` and sibling per-feature folders, so
`Package.swift`'s 60+ bare test filenames collapse to folder entries.

### 4.2 Enforcement mechanisms

Because `make lint` is Node-only and XCTest is unavailable (§2), each mechanism
below is deliberately matched to a checker that actually runs on this toolchain.

| Boundary | Mechanism | Runs via | Precedent |
|---|---|---|---|
| agent/v2 wire contract | `schema/agent-v2.schema.json` + **conformance runner diffing the Swift and Node decoders over one fixture corpus** | `make regression` | `scripts/conformance-memory.mjs` |
| Anthropic model ids | one canonical JSON list; both sides load or are checked against it | conformance runner + ESLint | `CLAUDE_SDK_IMPORT` |
| wire-event emission | ESLint forbids `type: 'approval_request'`-shaped literals outside `llm_agent/sdk/` | `npm run lint` | `forbidLayers` |
| Mac linker | `ClaudeLink` → own SwiftPM target (spike; see §6) | compiler | `graph-kit` products |
| Chat slice cohesion | `Package.swift` exclusion becomes a folder entry; a stray file breaks the lite build | 4 builds | `Graph`, `AutoTask` |

The conformance runner is the highest-value item, and per §2 it must diff both
sides rather than merely validate fixtures. It closes three drift classes the
audit found:

1. **The `questions` passthrough.** `engine.mjs:906` forwards the SDK's
   `AskUserQuestionInput` verbatim; Swift decodes `multiSelect` as non-optional
   (`AgentV2Event.swift:84-93`). An SDK rename throws during decode, never
   dispatches `.approvalRequest`, and parks the turn for the full 15-minute
   timeout. A fixture-only check would not catch this; a both-sides diff does.
2. **Field drift already present** — `usage.contextPercent` is declared in Swift
   and never emitted; `error.retryable` is emitted and absent in Swift;
   `approval.options[].preview` passes through Node and is undecodable in Swift.
3. **The five scattered emitters** (§1.4) — the runner enumerates the vocabulary
   from one place, so an event emitted outside the linker fails the gate.

Model ids get the same treatment: ESLint can forbid `claude-*` literals on the
Node side, but nothing lints Swift, so the canonical list is asserted from the
conformance runner instead of trusted to review.

## 5. Phases

Each phase ends green and is independently abandonable.

"Regression" below means the full `make regression` gate from §2: four builds
plus the graph gates.

| # | Work | Gate |
|---|---|---|
| 0 | Record baseline: `make regression` green, `npm test` green, lint clean. Nothing proceeds until the baseline is known-good | regression + `npm test` + lint |
| 1 | Chat → one vertical slice. Pure file moves. Update `Package.swift`, `CLAUDE.md`, `docs/spec/macos-app.md` | regression |
| 2 | Split God objects per §4.1. Unify 3 transcript renderers and 3 approval-card copies. Move `bubbleHeights` off the engine | regression + subagent review |
| 3 | Linker: wire schema, **conformance runner wired into `make regression`**, single model-id source, ESLint ratchet extension, `ClaudeLink` target spike | regression + `npm test` + lint |
| 4 | Behaviour fixes: v2 tool args/results/usage (depends on 2+3), timeout comments, second tool table | regression + **manual in-app checklist** |
| 5 | Memory/skill consolidation: end the double write+inject, unify catalogs, one `.skills-lock` owner | `npm test` + manual chat check |
| 6 | Delete dead Swift/JS; deprecate the three empty tables | regression + lint |

Phase 0 is not ceremony. Per repo memory, the push gate has produced false
signals before (a cold `mac/.build` makes `git push` exit 141 with the gate
reporting PASS and nothing pushed), so the baseline must be established before
any change lands.

Phase 4 is the first requiring in-app verification, because no automated Mac
test can cover it here. Phase 5 touches live prompt composition and carries the
weakest automated coverage of the set.

The new conformance runner from Phase 3 must be added to `make regression`
itself — per the Makefile's own warning, "a gate nothing runs is a gate in name
only".

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| 154/187 Mac tests cannot run locally | High | Phases 1–3 are behaviour-preserving and compile-checked; behaviour changes confined to Phase 4 with a manual checklist |
| `ClaudeLink` SwiftPM extraction proves invasive (it references ~10 app types) | Medium | Spike first. It imports only `Foundation`, which is promising, but `LlmIdeAPIClient` (×12) and `ChatTransport*` (×12) need dependency inversion. **Fall back to lint-only enforcement if the spike exceeds its budget** |
| Phase 5 changes what reaches the model | Medium | Ship the de-duplication first (identical facts injected twice is provably redundant); defer any change to *ranking* or *selection* |
| Concurrent sessions block the push gate | Medium | Known repo hazard: run `make regression` before pushing; foreground the push |
| Large diff obscures a regression | Medium | Per-phase review gates; every phase individually revertible |

## 7. Open questions

1. Does the `ClaudeLink` SwiftPM extraction fit a reasonable budget, or does
   dependency inversion over `LlmIdeAPIClient` cascade? Resolved by the Phase 3
   spike; lint-only is the documented fallback.
2. Should the merged memory store keep both lifetimes (durable project facts vs
   per-session facts) or collapse to one? The double *injection* is redundant
   regardless; the double *write* may be intentional for differing eviction.
   Decide in Phase 5 against `memory-writer.mjs` eviction policy.
3. Is the fault store worth a production writer, or should the read chain be
   removed? Deferred — the user chose "delete dead code, document tables", which
   leaves the fault reader in place; a follow-up decides.
