# Claude-linker Contract + v2 Tool-Data Recovery (Phases 3–4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mac↔server agent/v2 wire a machine-checked contract, then use that contract to recover the tool arguments, tool results and token usage the v2 transport currently throws away.

**Architecture:** A JSON schema plus a conformance runner that compares what the server EMITS against what Swift DECODES — field-set diffing, not fixture validation. Then widen the three legacy-shaped types (`AgentProgress`, `ChatMessage.ToolStep`, `ChatTransport`) that leave v2's richer data with nowhere to go.

**Tech Stack:** Swift 6.2.3 / SwiftPM, Node 20 (pure HTTP), `@anthropic-ai/claude-agent-sdk` 0.3.245

**Spec:** `docs/superpowers/specs/2026-09-10-chat-linker-restructure-design.md` (Phases 3–4). Phases 0–2 shipped as `04e88c5d`; see `docs/superpowers/plans/2026-09-10-chat-slice-restructure.md`, noting **Task 11 there was reverted** — `BubbleHeightCache` does not exist and `ChatEngine.bubbleHeights` is still the live cache.

## Global Constraints

- **No XCTest.** `make regression` skips `swift test`; `swift build --build-tests` fails with `no such module 'XCTest'`. 154/187 Mac test files can neither run nor compile-check. **Grep `mac/Tests/` by hand for any symbol this plan renames.**
- **The Mac gate is `make regression`** — `test-mac` + `build-mac-lite` + `build-mac-min` + `build-mac-mobile-only` + `graph-gates` + `chat-gates`.
- **The Node gate is `cd extension && npm test` and `npm run lint`.** Both run here.
- **Anything `chat-contract-lab` asserts must be `public`** — separate target, `@testable import` is test-target-only.
- SwiftPM only **warns** on an invalid `exclude` path and still exits 0. After any file move, `grep "Invalid Exclude"` the build log.
- Mac builds need `GIT_CONFIG_GLOBAL=/dev/null` and **must run outside the Bash sandbox**.
- `ChatMessage` and its nested types are **`Codable` and persisted** to `~/Library/Application Support/llm-ide/sessions/<uuid>.json`. Every added field must be optional or defaulted, and `ChatSessionV1Fixtures.swift` must still decode.
- Commit format `<type>(scope): <subject>`, ≤50 chars, no trailing period, ending with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Never push without asking.** Branch from `main`: `git switch -c refactor/linker-contract`.

## Verified starting facts

Re-confirmed on `main` at `04e88c5d`:

- **v2 wire events are emitted from four files, one inside the linker.**
  `llm_agent/sdk/events.mjs` + `llm_agent/sdk/engine.mjs` (in), `llm_agent/runtime/task-session-context.mjs:53`, `routes/agent-v2.mjs:257,340,350,368`, `server/ai-routes.mjs:180,301,559,561` (out).
- **Three Anthropic model lists disagree**, and two of the server's three chain entries are ids the Mac treats as retired:
  `ClaudeLink/ClaudeCLI.swift:36-42` vs `kb/usage.mjs:28-34` vs `providers/runtime.mjs:48` (`DEFAULT_MODEL = 'claude-sonnet-4-6'`, which `ClaudeCLI.retiredModelIds` maps to `claude-sonnet-5`).
- **The approval timeout is `900_000` ms** (`sdk/decisions.mjs:19`) while five comments say 300 s (`sdk/engine.mjs:640,888`, `tools/registry.mjs:172,197`, `server/ai-routes.mjs:470`).
- **The three types that block v2 data:**
  `ChatTransport.roundTrip` carries only `AgentProgress` + `String` + `AgentV2Approval` (`Chat/Transport/ChatTransport.swift:8-40`); `AgentProgress` is `label/phase/tool/detail` (`Services/API/LlmIdeAPIClient+CodeAssist.swift:162-168`); `ChatMessage.ToolStep` is `id/label/tool/at` (`Chat/Models/ChatMessage.swift:29-41`).
- **What v2 drops:** `AgentV2Transport.swift` `break`s on `.toolArgsDelta` and `.usage`, and keeps only the tool name from `.toolResult` (dropping `text`, `isError`, `truncated`); `fireToolProgress` hardcodes `detail: nil`.
- **A second tool table** lives at `Chat/Models/ChatMessage.swift:45-59`, keyed on raw kebab-case names, so every SDK built-in (`Read`, `Bash`, `Edit`) renders as a generic wrench.
- **Precedent to mirror:** `mac/LocalPackages/graph-kit/schema/{SCHEMA.md,graph.schema.json,fixtures/}` + a 301-line `scripts/conformance-memory.mjs` that runs both language tracks and diffs them.

---

## Phase 3 — make the contract machine-checked

### Task 1: Branch and baseline

- [ ] **Step 1: Branch from a clean main**

```bash
cd /Users/dinesh.malla/llm-ide && git switch main && git status --short
```
Expected: only the known-dirty ` m .skills` line. Then:
```bash
git switch -c refactor/linker-contract
```

- [ ] **Step 2: Record the baseline**

```bash
cd /Users/dinesh.malla/llm-ide && make regression > /tmp/base.log 2>&1; echo "EXIT=$?"
cd extension && npm test > /tmp/basenode.log 2>&1; echo "NODE=$?"; npm run lint; echo "LINT=$?"
```
Expected: all zero. If not, STOP — do not build on a red baseline.

---

### Task 2: Write the wire schema and fixtures

**Files:**
- Create: `schema/agent-v2/agent-v2.schema.json`
- Create: `schema/agent-v2/SCHEMA.md`
- Create: `schema/agent-v2/fixtures/{init,delta,tool_use_start,tool_args_delta,tool_result,usage,result,sdk,approval_request_tool,approval_request_question,approval_resolved,mode_set,tasks,tasks_progress,error}.json`

**Interfaces:**
- Consumes: nothing
- Produces: the canonical event vocabulary. Every fixture is one complete SSE `data:` payload. The schema's `oneOf` is keyed on `type`.

- [ ] **Step 1: Enumerate the real vocabulary from the emitters**

Read each emitter and transcribe its literal shape — do not invent fields:
`llm_agent/sdk/events.mjs:33-117` (init, delta, tool_use_start, tool_args_delta, tool_result, usage, result, sdk), `llm_agent/sdk/engine.mjs:793,906` (approval_request ×2), `:795,912` (approval_resolved), `routes/agent-v2.mjs:257,340,350,368` (mode_set, tasks, error), `llm_agent/runtime/task-session-context.mjs:53` (tasks_progress).

- [ ] **Step 2: Write one fixture per event type**

Each fixture is the exact JSON the server writes after `data: `. Include the fields the Mac currently ignores — `error.retryable`, `sdk.subtype`, `sdk.raw`, `approval.options[].preview` — because their absence on the Swift side is precisely what the runner must surface.

- [ ] **Step 3: Write the schema with `additionalProperties: false` per variant**

This is what makes a newly-added server field fail the gate instead of passing silently.

- [ ] **Step 4: Write `SCHEMA.md`** — one paragraph per event: who emits it (file:line), what consumes it, and any field deliberately not decoded by the Mac, with the reason.

- [ ] **Step 5: Commit**

```bash
git add schema/agent-v2 && git commit -m "docs(linker): agent/v2 ワイヤの正準スキーマとフィクスチャ" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Teach `chat-contract-lab` to dump what Swift decodes

The Swift half of the conformance check. The lab gains an argument mode; its existing assertions still run when no argument is given.

**Files:**
- Modify: `mac/Sources/ChatContractLab/main.swift`
- Modify: `mac/Sources/LlmIdeMac/ClaudeLink/AgentV2Event.swift` (add a public field-report)

**Interfaces:**
- Consumes: `AgentV2Event`
- Produces: `chat-contract-lab --decode <fixtures-dir>` printing one JSON object per fixture: `{"file":"…","decoded":true,"captured":["sessionId","model",…]}` — `captured` lists the fields the Swift type actually stored, sorted.

- [ ] **Step 1: Add `public func decodedFieldNames() -> [String]` to `AgentV2Event`**

Return the non-nil field names this case carried, so the runner can diff against the fixture's own key set. Keep it exhaustive over the enum so a new case forces a compile error here.

- [ ] **Step 2: Add the `--decode` mode to `main.swift`**

Read every `*.json` in the directory, run it through `AgentV2Event.decode`, print one line of JSON per file. A fixture that fails to decode prints `{"file":…,"decoded":false,"error":"…"}` and does NOT exit non-zero — the Node runner decides what is fatal.

- [ ] **Step 3: Verify by hand**

```bash
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab --decode ../schema/agent-v2/fixtures
```
Expected: one line per fixture. Confirm `error.json` shows `retryable` absent from `captured` — that is the known drift this whole task exists to catch.

- [ ] **Step 4: Confirm the no-argument path still runs the 16 assertions**

```bash
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab
```
Expected: `all assertions passed`.

- [ ] **Step 5: Commit**

---

### Task 4: The conformance runner

**Files:**
- Create: `scripts/conformance-agent-v2.mjs`
- Modify: `Makefile` — add to `chat-gates`

**Interfaces:**
- Consumes: `schema/agent-v2/`, `chat-contract-lab --decode`
- Produces: exit 1 on any of: fixture fails the schema; an emitter's literal shape is absent from the schema; a schema field is missing from Swift's `captured` set without an explicit allow-entry.

- [ ] **Step 1: Validate every fixture against the schema** (fail on invalid).

- [ ] **Step 2: Diff schema fields against Swift's `captured` set**

For each fixture, `schemaFields - captured` must be empty OR listed in an `ALLOWED_UNDECODED` table in the script, each entry carrying a one-line reason (e.g. `sdk.raw — deliberately dropped, see AgentV2Event.swift:281-283`). **An unexplained gap is a failure.** This is the check that would have caught `error.retryable`.

- [ ] **Step 3: Assert the emitter roster**

Grep `extension/` for `type: '<name>'` emissions and assert every emitted `type` exists in the schema. This catches a fifth emitter appearing outside the linker.

- [ ] **Step 4: Make it fail on purpose, then pass**

Temporarily delete `retryable` from `ALLOWED_UNDECODED` (or add a bogus field to a fixture) and confirm exit 1 with a readable message. Restore, confirm exit 0. **A gate that cannot fail is worthless — prove both directions before wiring it in.**

- [ ] **Step 5: Wire into `chat-gates` and run `make regression`**

- [ ] **Step 6: Commit**

---

### Task 5: One source for Anthropic model ids

**Files:**
- Create: `schema/models/anthropic-models.json`
- Modify: `mac/Sources/LlmIdeMac/ClaudeLink/ClaudeCLI.swift`
- Modify: `extension/kb/usage.mjs`, `extension/providers/runtime.mjs`
- Modify: `scripts/conformance-agent-v2.mjs` (assert all three agree)

**Interfaces:**
- Produces: `{ "models": [{"id","displayName","fast"?}], "default": "…", "retired": {"old":"new"} }`

- [ ] **Step 1: Decide the canonical list.** The server's `DEFAULT_MODEL` is currently `claude-sonnet-4-6`, which the Mac retires to `claude-sonnet-5`. **Resolve toward the Mac's list** (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-4-8`) — it is the newer set and matches the repo's stated "default to the latest Claude models".

- [ ] **Step 2: Node reads the JSON at load** in `usage.mjs` and `runtime.mjs`.

- [ ] **Step 3: Swift keeps its literal list** (a build-time resource read would complicate the reduced builds) **but the conformance runner asserts it matches the JSON**, parsing `ClaudeCLI.swift` for the ids. Cheaper and safer than a resource dependency.

- [ ] **Step 4: Prove the gate fails** by changing one id in `ClaudeCLI.swift`, then revert.

- [ ] **Step 5: `npm test`, `make regression`, commit.**

---

### Task 6: Extend the ESLint ratchet

**Files:** `extension/eslint.config.mjs`

- [ ] **Step 1: Forbid wire-event literals outside `llm_agent/sdk/`**

Add a `no-restricted-syntax` rule matching object literals with a `type` property whose value is one of the schema's event names, allowed only under `llm_agent/sdk/`. Model it on the existing `CLAUDE_SDK_IMPORT` block (`eslint.config.mjs:33-49`) — same shape, same "see docs/explanation/claude-linker.md" message.

- [ ] **Step 2: Expect violations, and do NOT exempt them per-file**

The three known out-of-linker emitters will fail. Either move the emission into the linker, or record them in one clearly-commented allow-list with a reason and a follow-up note. **Never add per-file exemptions** — the repo's ratchet is at zero and CLAUDE.md forbids it.

- [ ] **Step 3: Forbid `claude-*` model-id string literals** outside `llm_agent/sdk/`, `providers/`, and the new JSON.

- [ ] **Step 4: `npm run lint` clean, commit.**

---

### Task 7: Fix the timeout comments

**Files:** `extension/llm_agent/sdk/engine.mjs:640,888`, `extension/llm_agent/tools/registry.mjs:172,197`, `extension/server/ai-routes.mjs:470`

- [ ] **Step 1: Replace every "300 s" with the real 15 minutes**, and cite `sdk/decisions.mjs:19` as the source of truth rather than restating the number where it can drift again.
- [ ] **Step 2: `npm test`, commit.**

**Phase 3 ends here.** The contract is enforced; nothing user-visible has changed. Stopping here is coherent.

---

## Phase 4 — recover the dropped tool data

### Task 8: Widen the tool-event channel

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift` (`AgentProgress`)
- Modify: `mac/Sources/LlmIdeMac/Chat/Transport/ChatTransport.swift`

**Interfaces:**
- Produces: `AgentProgress` gains `args: String?`, `resultText: String?`, `isError: Bool?`, `truncated: Bool?`. All optional — the legacy engine supplies none of them, and its behaviour must not change.

- [ ] **Step 1: Add the optional fields with a memberwise default**, so every existing construction site compiles untouched. Verify with a build before changing any call site.
- [ ] **Step 2: Confirm the legacy path still sends exactly what it sent** — `ai-routes.mjs` progress events carry no args/result, so legacy `AgentProgress` values must have all four new fields nil.
- [ ] **Step 3: `make regression`, commit.**

---

### Task 9: Widen `ChatMessage.ToolStep` (persisted — migration required)

**Files:** `mac/Sources/LlmIdeMac/Chat/Models/ChatMessage.swift`

- [ ] **Step 1: Add lab assertions FIRST** — a `ToolStep` encoded without the new fields must decode; a v1 fixture must still decode. Add to `chat-contract-lab`; run it and watch it fail.
- [ ] **Step 2: Add `args: String?`, `resultText: String?`, `isError: Bool?`** with defaults, keeping `Codable` synthesis backward-compatible (optionals decode as nil when absent).
- [ ] **Step 3: Run the lab — green.**
- [ ] **Step 4: Grep `mac/Tests/` for `ToolStep(` and confirm every construction still compiles** — remember tests are never compiled here, so this grep IS the check.
- [ ] **Step 5: Verify `ChatSessionV1Fixtures.swift` still describes a decodable shape** by reading it.
- [ ] **Step 6: `make regression`, commit.**

---

### Task 10: Stop `AgentV2Transport` dropping data

**Files:** `mac/Sources/LlmIdeMac/ClaudeLink/AgentV2Transport.swift`

- [ ] **Step 1: Accumulate `tool_args_delta`** per `toolUseId` into a `[String: String]` of partial JSON, and attach the assembled args to the progress event emitted at `tool_result`.
- [ ] **Step 2: Carry `payload.text` / `isError` / `truncated`** into the new `AgentProgress` fields instead of discarding them.
- [ ] **Step 3: Derive `detail`** — the salient argument — so v2 tool lines read "Reading Foo.swift" like legacy's, instead of a bare verb. The server-side equivalent is `loop.mjs:162-176`; put the v2 version in `ClaudeToolPresentation` (the linker), not in the transport.
- [ ] **Step 4: Decide `usage`.** Token counts have no home in `AgentProgress` (they are per-turn, not per-tool). Either add them to the turn's `ChatMessage.Metadata` or leave `.usage` consumed-and-dropped with a comment saying where they WOULD go. Do not invent a UI for them here.
- [ ] **Step 5: `make regression` + the conformance runner** — `captured` should now include the previously-missing fields, so any `ALLOWED_UNDECODED` entries they had must be removed in the same commit.
- [ ] **Step 6: MANUAL CHECK — this is user-visible.** Run the app, start a v2 chat, trigger a tool call, and confirm: the tool line names the file; a tool error shows as an error; nothing regressed on a legacy-engine chat. Report what you saw; do not assume.
- [ ] **Step 7: Commit.**

---

### Task 11: Kill the second tool table

**Files:** `mac/Sources/LlmIdeMac/Chat/Models/ChatMessage.swift:45-59`, `mac/Sources/LlmIdeMac/ClaudeLink/ClaudeToolPresentation.swift`

- [ ] **Step 1: Move the SF-Symbol mapping into `ClaudeToolPresentation`** as `icon(for:)`, keyed on `normalizedToolName` so SDK built-ins stop falling through to the wrench.
- [ ] **Step 2: Delete the dead verb cases** the audit found — `list-issues` / `get-issue` (no such tools) and `task` / `todowrite` (always denied by `canUseTool`, `engine.mjs:813-815`). Verify each with a grep across `extension/` and `.skills/` before deleting.
- [ ] **Step 3: `ChatMessage.icon` delegates** to the linker, one line.
- [ ] **Step 4: `make regression`, commit.**

---

## Self-Review

**Spec coverage.** Phase 3 → Tasks 1–7 (schema+fixtures 2, Swift decode-report 3, runner 4, model ids 5, ESLint 6, timeout comments 7). Phase 4 → Tasks 8–11 (channel 8, persisted model 9, transport 10, tool table 11).

**Placeholder scan.** Task 2 Steps 1–3 and Task 4 Steps 1–3 describe what to write rather than giving the literal JSON, because the fixtures must be transcribed from the emitters as they exist at implementation time — inventing them here would bake in today's guesses as tomorrow's contract. Each says exactly which file:line to transcribe from. Task 10 Step 4 leaves a genuine design choice open and says so rather than pretending.

**Type consistency.** `AgentProgress`'s four new fields (Task 8) are the same four consumed in Task 10. `ToolStep`'s three new fields (Task 9) are `args`/`resultText`/`isError` — note `ToolStep` does NOT get `truncated`, which is a transport-level fact, not a persisted one. `decodedFieldNames()` (Task 3) is the input to the diff in Task 4 Step 2.

**Ordering.** Task 8 must precede Task 10 (nowhere to put the data otherwise) and Task 9 must precede any persistence of it. Task 4 must precede Task 10 so the runner can prove the drift closed rather than merely asserting it.

**Honest risk.** Task 10 Step 6 is the only step no automated gate here can cover. Task 6 may find that moving the three stray emitters into the linker is larger than it looks; the fallback (one commented allow-list) is stated rather than discovered mid-task.
