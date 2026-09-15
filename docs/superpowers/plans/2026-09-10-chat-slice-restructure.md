# Mac Chat Vertical Slice Implementation Plan (Phases 0–2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate ~14,000 lines of Mac chat code from five scattered locations into one vertical slice matching the repo's `Graph/AutoTask/LoopEngine` convention, then split its God objects and remove its triplicated UI — with no behaviour change.

**Architecture:** Pure `git mv` first (Swift has no path-based imports, so moves inside one SwiftPM target cannot break references), then extract self-contained units. A new `chat-contract-lab` executable target restores TDD on a toolchain that has no XCTest.

**Tech Stack:** Swift 6.2.3, SwiftPM, SwiftUI, Command Line Tools 26.0 (no Xcode)

**Spec:** `docs/superpowers/specs/2026-09-10-chat-linker-restructure-design.md`

**Scope note:** This plan covers spec Phases 0–2 only. Phases 3–4 (linker contract + v2 data loss) and 5–6 (memory/skill consolidation + dead code) are separate plans, written after this one lands. This plan produces working software on its own.

## Global Constraints

- **No XCTest on this machine.** `xcode-select -p` is `/Library/Developer/CommandLineTools`; `make -n test-mac` prints `⚠ Skipping mac swift test`. `swift test` is NOT a gate. Do not write a step that runs it.
- **The gate is `make regression`** — `test-mac` (full build) + `build-mac-lite` + `build-mac-min` + `build-mac-mobile-only` + `graph-gates`.
- **TDD happens through `swift run`.** Executable SwiftPM products run without XCTest (precedent: `graph-layout-lab`). Task 10 adds `chat-contract-lab` for this; Tasks 11–14 use it.
- **All Mac sources are one SwiftPM target.** Moving a `.swift` file changes no imports and breaks no references. The only path-sensitive file is `mac/Package.swift`.
- `agent_chat` is **not** an excludable feature (`Package.swift:21-24`) — Chat compiles into every variant.
- Builds need `GIT_CONFIG_GLOBAL=/dev/null` and must run **outside the Bash sandbox** (`dangerouslyDisableSandbox: true`); the sandbox blocks SwiftPM's own `sandbox-exec`.
- Commit format: `<type>(scope): <subject>`, ≤50 chars, no trailing period. End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Never push.** This plan commits only; the user asks for pushes explicitly.
- Comments and docstrings in English.
- Use `git mv` (not `mv`) so history follows the file.

---

### Task 1: Establish the baseline

No code change. A green baseline must exist before anything moves, because a cold `mac/.build` has previously made the push gate report PASS while pushing nothing.

**Files:** none

**Interfaces:**
- Consumes: nothing
- Produces: a recorded baseline result later tasks compare against

- [ ] **Step 1: Confirm the working tree is clean**

```bash
cd /Users/dinesh.malla/llm-ide && git status --short
```
Expected: no output (clean), or only the known-dirty `.skills` submodule line ` m .skills`.

- [ ] **Step 2: Run the full gate (sandbox disabled, ~10–20 min cold)**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS. If it fails, STOP and report — do not begin moving files onto a red baseline.

- [ ] **Step 3: Record the result**

Append the date, the command, and PASS/FAIL to the plan's progress notes. No commit.

---

### Task 2: Create the slice skeleton and move the models

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/{Models,Engine,Session,Transport,Services,Views/Panel,Views/Quick,Views/Shared}/`
- Move: `Chat/ChatMessage.swift` → `Chat/Models/ChatMessage.swift`
- Move: `Models/ChatSession.swift` → `Chat/Models/ChatSession.swift`

**Interfaces:**
- Consumes: nothing
- Produces: the folder skeleton every later task moves into. No symbol changes — `ChatMessage` and `ChatSession` keep their names and visibility.

- [ ] **Step 1: Create the folders**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Chat && \
mkdir -p Models Engine Session Transport Services Views/Panel Views/Quick Views/Shared
```

- [ ] **Step 2: Move the two model files**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && \
git mv Chat/ChatMessage.swift Chat/Models/ChatMessage.swift && \
git mv Models/ChatSession.swift Chat/Models/ChatSession.swift
```

- [ ] **Step 3: Build to prove moves are inert**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --product LlmIdeMac
```
Expected: PASS with no new warnings. A failure here means something references files by path — investigate before continuing.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Sources/LlmIdeMac && \
git commit -m "refactor(mac): Chat スライスの骨格と Models を作成

$(printf 'Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Move the engine files

`ChatEngine+AutoChain.swift` is renamed because it contains no `extension ChatEngine` at all — it declares two free types. The name currently lies about its contents.

**Files:**
- Move: `Chat/ChatEngine.swift` → `Chat/Engine/ChatEngine.swift`
- Move: `Chat/ChatEngine+History.swift` → `Chat/Engine/ChatEngine+History.swift`
- Move: `Chat/ChatEngine+PanelWrites.swift` → `Chat/Engine/ChatEngine+PanelWrites.swift`
- Move: `Chat/ChatEngine+ExternalTurn.swift` → `Chat/Engine/ChatEngine+ExternalTurn.swift`
- Move+rename: `Chat/ChatEngine+AutoChain.swift` → `Chat/Engine/ChatAutoChainPolicy.swift`

**Interfaces:**
- Consumes: `Chat/Models/` from Task 2
- Produces: `Chat/Engine/` as the home for engine internals. No symbol renames.

- [ ] **Step 1: Move the four extensions and rename the fifth**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && \
git mv Chat/ChatEngine.swift              Chat/Engine/ChatEngine.swift && \
git mv Chat/ChatEngine+History.swift      Chat/Engine/ChatEngine+History.swift && \
git mv Chat/ChatEngine+PanelWrites.swift  Chat/Engine/ChatEngine+PanelWrites.swift && \
git mv Chat/ChatEngine+ExternalTurn.swift Chat/Engine/ChatEngine+ExternalTurn.swift && \
git mv Chat/ChatEngine+AutoChain.swift    Chat/Engine/ChatAutoChainPolicy.swift
```

- [ ] **Step 2: Fix the stale header comment in the renamed file**

`ChatAutoChainPolicy.swift` opens with a comment describing itself as a `ChatEngine` extension. Replace the header's first line so the file describes what it is: two free policy types (`ChatAutoChainDecision` and its inputs), deliberately holding no engine reference so the decision table is testable in isolation.

- [ ] **Step 3: Build**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --product LlmIdeMac
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Sources/LlmIdeMac && \
git commit -m "refactor(mac): エンジンを Chat/Engine へ移動

AutoChain は extension ではなく自由型なので実態に合わせて改名。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Move the session files and update `Package.swift`

This is the one task with a path-sensitive edit: `Package.swift:161` excludes `Chat/ExplorerMobileEngineResolver.swift` for the `mobile_sync`-off builds. Moving the file without updating that line breaks `build-mac-lite`/`build-mac-min` — which is exactly why those variants are in the gate.

**Files:**
- Move: `Chat/ChatEngine+Session.swift` → `Chat/Session/ChatEngine+Session.swift`
- Move: `Chat/QuickChatContext.swift` → `Chat/Session/QuickChatContext.swift`
- Move: `Chat/ExplorerMobileEngineResolver.swift` → `Chat/Session/ExplorerMobileEngineResolver.swift`
- Move: `Services/ChatSessionStore.swift` → `Chat/Session/ChatSessionStore.swift`
- Modify: `mac/Package.swift:161`

**Interfaces:**
- Consumes: `Chat/Engine/` from Task 3
- Produces: `Chat/Session/`. No symbol renames.

- [ ] **Step 1: Move the four files**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && \
git mv Chat/ChatEngine+Session.swift          Chat/Session/ChatEngine+Session.swift && \
git mv Chat/QuickChatContext.swift            Chat/Session/QuickChatContext.swift && \
git mv Chat/ExplorerMobileEngineResolver.swift Chat/Session/ExplorerMobileEngineResolver.swift && \
git mv Services/ChatSessionStore.swift        Chat/Session/ChatSessionStore.swift
```

- [ ] **Step 2: Update the exclude path**

In `mac/Package.swift`, change the entry
`"Chat/ExplorerMobileEngineResolver.swift",`
to
`"Chat/Session/ExplorerMobileEngineResolver.swift",`

Also update the comment two lines above it that lists where the mobile unit is scattered, so it names `Chat/Session/` rather than `Chat/`.

- [ ] **Step 3: Prove the exclude still resolves — build the variant that uses it**

```bash
cd /Users/dinesh.malla/llm-ide && make build-mac-min
```
Expected: PASS. SwiftPM errors on an exclude path that does not exist, so a stale path fails loudly here rather than silently compiling the file into the min build.

- [ ] **Step 4: Build the full product too**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --product LlmIdeMac
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Sources/LlmIdeMac mac/Package.swift && \
git commit -m "refactor(mac): セッション層を Chat/Session へ移動

Package.swift の mobile_sync 除外パスも追従。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Move transport and services

`AgentV2EngineTransport` currently lives in `AgentV2Selection.swift` alongside two unrelated types. It moves to `ClaudeLink/` in a later plan; here the file only relocates.

**Files:**
- Move: `Chat/ChatTransport.swift` → `Chat/Transport/ChatTransport.swift`
- Move: `Chat/AgentV2Selection.swift` → `Chat/Transport/AgentV2Selection.swift`
- Move: `Chat/ChatEngineRegistry.swift` → `Chat/Services/ChatEngineRegistry.swift`
- Move: `Services/ChatSlashCommands.swift` → `Chat/Services/ChatSlashCommands.swift`
- Move: `Services/ChatVoiceState.swift` → `Chat/Services/ChatVoiceState.swift`
- Move: `Services/ChatModule.swift` → `Chat/Services/ChatModule.swift`

**Interfaces:**
- Consumes: `Chat/Session/` from Task 4
- Produces: `Chat/Transport/`, `Chat/Services/`. No symbol renames.

- [ ] **Step 1: Move the six files**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && \
git mv Chat/ChatTransport.swift        Chat/Transport/ChatTransport.swift && \
git mv Chat/AgentV2Selection.swift     Chat/Transport/AgentV2Selection.swift && \
git mv Chat/ChatEngineRegistry.swift   Chat/Services/ChatEngineRegistry.swift && \
git mv Services/ChatSlashCommands.swift Chat/Services/ChatSlashCommands.swift && \
git mv Services/ChatVoiceState.swift   Chat/Services/ChatVoiceState.swift && \
git mv Services/ChatModule.swift       Chat/Services/ChatModule.swift
```

- [ ] **Step 2: Build**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift build --product LlmIdeMac
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Sources/LlmIdeMac && \
git commit -m "refactor(mac): transport と services を Chat 配下へ移動

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Move the views

Three destinations by role: the Code Assistant panel, the quick-chat surfaces (sheet + menu bar), and components shared between them.

**Files:**
- Move: all 33 files in `Views/CodeAssistant/*.swift` → `Chat/Views/Panel/`
- Move: `Views/CodeAssistant/Chat/AgentV2ApprovalState.swift` → `Chat/Views/Shared/AgentV2ApprovalState.swift`
- Move: `Views/CodeAssistant/ToolApprovalCard.swift` → `Chat/Views/Shared/ToolApprovalCard.swift`
- Move: `Views/CodeAssistant/ApprovalQuestionCard.swift` → `Chat/Views/Shared/ApprovalQuestionCard.swift`
- Move: `Views/Shell/LlmChatSheet.swift`, `LlmChatViewModel.swift`, `LlmChatStatusBadge.swift` → `Chat/Views/Quick/`
- Move: `Views/MenuBar/MenuBarChatView.swift`, `MenuBarChatWindowHandle.swift` → `Chat/Views/Quick/`

**Interfaces:**
- Consumes: everything from Tasks 2–5
- Produces: `Chat/Views/{Panel,Quick,Shared}/`. No symbol renames; `CodeAssistantPanel` and its 13 extension files keep their names.

- [ ] **Step 1: Move the panel, then lift the three shared cards back out**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && \
git mv Views/CodeAssistant/Chat/AgentV2ApprovalState.swift Chat/Views/Shared/AgentV2ApprovalState.swift && \
rmdir Views/CodeAssistant/Chat && \
for f in Views/CodeAssistant/*.swift; do git mv "$f" "Chat/Views/Panel/$(basename "$f")"; done && \
git mv Chat/Views/Panel/ToolApprovalCard.swift     Chat/Views/Shared/ToolApprovalCard.swift && \
git mv Chat/Views/Panel/ApprovalQuestionCard.swift Chat/Views/Shared/ApprovalQuestionCard.swift && \
rmdir Views/CodeAssistant
```

- [ ] **Step 2: Move the quick-chat surfaces**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && \
git mv Views/Shell/LlmChatSheet.swift          Chat/Views/Quick/LlmChatSheet.swift && \
git mv Views/Shell/LlmChatViewModel.swift      Chat/Views/Quick/LlmChatViewModel.swift && \
git mv Views/Shell/LlmChatStatusBadge.swift    Chat/Views/Quick/LlmChatStatusBadge.swift && \
git mv Views/MenuBar/MenuBarChatView.swift     Chat/Views/Quick/MenuBarChatView.swift && \
git mv Views/MenuBar/MenuBarChatWindowHandle.swift Chat/Views/Quick/MenuBarChatWindowHandle.swift
```

- [ ] **Step 3: Check whether `Views/MenuBar` is now empty**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac && ls -1 Views/MenuBar/ 2>/dev/null || echo "gone"
```
If it lists files, leave the folder. If it is empty, `rmdir Views/MenuBar`.

- [ ] **Step 4: Run the FULL gate — this is the largest move**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS, matching Task 1's baseline.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Sources/LlmIdeMac && \
git commit -m "refactor(mac): チャット UI を Chat/Views 配下へ集約

Panel / Quick / Shared の3役割に分離。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Fold the tests into a folder and collapse `Package.swift`

The 187 test files are flat, which forces `testExcludes` to list bare filenames. Foldering the chat tests is the first step toward collapsing that list.

**Files:**
- Create: `mac/Tests/LlmIdeMacTests/Chat/`
- Move: the 22 chat/agent-v2 test files listed below
- Modify: `mac/Package.swift` — `testExcludes` entries for moved files

**Interfaces:**
- Consumes: nothing from earlier tasks (tests reference types, not paths)
- Produces: `Tests/LlmIdeMacTests/Chat/` as the pattern later features follow

- [ ] **Step 1: Move the chat test files**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Tests/LlmIdeMacTests && mkdir -p Chat && \
for f in AgentV2ApprovalTests.swift AgentV2EventTests.swift AgentV2SelectionTests.swift \
         AgentV2TransportTests.swift ChatAcknowledgeTests.swift ChatAutoChainPolicyTests.swift \
         ChatEngineBackgroundSessionTests.swift ChatEngineMessageTests.swift \
         ChatEngineRegistryTests.swift ChatEngineSessionTests.swift \
         ChatEngineStreamingPerfTests.swift ChatEngineTurnTests.swift \
         ChatMessageMigrationTests.swift ChatSessionProjectScopingTests.swift \
         ChatSessionStoreTests.swift ChatSessionV1Fixtures.swift ChatSlashCommandsTests.swift \
         ChatStoreOverrideGate.swift ChatStoreOverrideGateTests.swift \
         QuickChatContextTests.swift QuickChatSharedEngineTests.swift \
         ToolApprovalCardTests.swift ToolApprovalTests.swift; do
  test -f "$f" && git mv "$f" "Chat/$f"
done
```

- [ ] **Step 2: Update `testExcludes` for the two moved files that appear there**

`Package.swift`'s `mobileTestExcludes` set lists `ExplorerMobileEngineResolverTests.swift`. Check whether that file moved in Step 1 — it is not in the list above, so it stays flat and its exclude entry is unchanged. Verify with:

```bash
cd /Users/dinesh.malla/llm-ide/mac && \
grep -o '"[A-Za-z0-9+]*Tests\.swift"' Package.swift | tr -d '"' | while read -r n; do
  test -f "Tests/LlmIdeMacTests/$n" || echo "STALE EXCLUDE: $n"
done
```
Expected: no `STALE EXCLUDE` lines. Any that appear must be re-pointed to `Chat/<name>` before continuing.

- [ ] **Step 3: Build the variants that consume `testExcludes`**

```bash
cd /Users/dinesh.malla/llm-ide && make build-mac-lite && make build-mac-min
```
Expected: PASS. A stale exclude path fails SwiftPM manifest loading.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Tests mac/Package.swift && \
git commit -m "test(mac): チャットのテストを Chat/ フォルダへ集約

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Update the documentation that names the old paths

Three docs name chat paths, and two are **already stale** — `docs/spec/macos-app.md` says `Views/CodeAssistantPanel.swift`, but the file has been at `Views/CodeAssistant/CodeAssistantPanel.swift` for some time. Fix both the staleness and the move.

**Files:**
- Modify: `CLAUDE.md` — the Project Structure tree
- Modify: `docs/spec/macos-app.md:367,402,413,433`
- Modify: `docs/explanation/invariants.md:388`

**Interfaces:**
- Consumes: the final layout from Tasks 2–7
- Produces: docs a newcomer can follow

- [ ] **Step 1: Add the Chat slice to `CLAUDE.md`'s structure tree**

Under `mac/Sources/LlmIdeMac/`, insert a `Chat/` entry in the same style as the existing `Graph/`, `AutoTask/` and `LoopEngine/` blocks, listing `Models/ Engine/ Session/ Transport/ Services/ Views/{Panel,Quick,Shared}` with a one-line purpose each.

- [ ] **Step 2: Fix the four `docs/spec/macos-app.md` references**

Replace every `Views/CodeAssistantPanel.swift` with `Chat/Views/Panel/CodeAssistantPanel.swift`, and `Views/GitOpSheet.swift` stays as-is (it did not move).

- [ ] **Step 3: Fix `docs/explanation/invariants.md:388`**

Replace `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`, `HistoryTextEditor.swift` with the new `Chat/Views/Panel/` paths.

- [ ] **Step 4: Verify no stale path remains**

```bash
cd /Users/dinesh.malla/llm-ide && \
grep -rn "Views/CodeAssistant\|Views/Shell/LlmChat\|Views/MenuBar/MenuBarChat" \
  --include="*.md" . | grep -v node_modules | grep -v superpowers/specs || echo "clean"
```
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A CLAUDE.md docs && \
git commit -m "docs: Chat スライスの新パスに追従

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

**Phase 1 ends here.** The tree compiles across all four variants and Chat is one slice. Stopping now is a coherent outcome.

---

### Task 9: Add the `chat-contract-lab` executable gate

This unlocks TDD for Phase 2. `swift test` cannot run here, but `swift run` can — the same reason `graph-layout-lab` exists.

**Files:**
- Create: `mac/Sources/ChatContractLab/main.swift`
- Modify: `mac/Package.swift` — add an `.executable` product and target
- Modify: `Makefile` — add `chat-gates` and add it to `regression`

**Interfaces:**
- Consumes: the library target **`LlmIdeMacLib`** (name confirmed at `Package.swift:255`; its path is `Sources/LlmIdeMac`). The product `LlmIdeMac` is the *executable* built from target `LlmIdeMacMain` — do not depend on that.
- Produces: `expect(_ condition: Bool, _ label: String)` and a non-zero exit on failure — the assertion helper Tasks 10–14 call.

> **Access-control consequence, and why it shapes every later task.** A separate
> executable target sees only `public` symbols of `LlmIdeMacLib`; Swift's default
> `internal` is module-scoped and `@testable import` works only for test targets.
> So **every type Tasks 10–14 extract for lab assertion must be declared `public`
> with a `public init`.** This is the same trade graph-kit makes — `GraphCore`'s
> types are public precisely so `graph-layout-lab` can assert them. The
> alternative (putting assertions inside the library) would ship test code in the
> app binary and is rejected.

- [ ] **Step 1: Write the lab harness with one deliberately failing assertion**

Create `mac/Sources/ChatContractLab/main.swift`:

```swift
import Foundation
import LlmIdeMacLib

var failures: [String] = []

/// Assert `condition`, recording `label` on failure. Executable gates run
/// where XCTest cannot (a Command-Line-Tools toolchain has no XCTest), so
/// this stands in for a test assertion.
func expect(_ condition: Bool, _ label: String) {
    if condition {
        print("  ok  \(label)")
    } else {
        failures.append(label)
        print("  FAIL \(label)")
    }
}

print("chat-contract-lab")

// Placeholder proving the harness reports failure correctly. Task 11 replaces it.
expect(false, "harness reports failures")

if failures.isEmpty {
    print("chat-contract-lab: all assertions passed")
} else {
    print("chat-contract-lab: \(failures.count) FAILED")
    exit(1)
}
```

- [ ] **Step 2: Register the product and target in `mac/Package.swift`**

Add to `products:`:

```swift
.executable(name: "chat-contract-lab", targets: ["ChatContractLab"]),
```

Add to `targets:`:

```swift
.executableTarget(
    name: "ChatContractLab",
    dependencies: ["LlmIdeMacLib"],
    path: "Sources/ChatContractLab"
),
```

Note the dependency is `LlmIdeMacLib` (the `.target` at `Package.swift:255`), not
`LlmIdeMac` (the `.executable` product).

- [ ] **Step 3: Run it and confirm it FAILS**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: prints `FAIL harness reports failures` and `exit=1`. This proves the gate can actually fail — a gate that cannot fail is worthless.

- [ ] **Step 4: Flip the placeholder to passing**

Change `expect(false, "harness reports failures")` to `expect(true, "harness reports failures")`.

- [ ] **Step 5: Run it and confirm it PASSES**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: `chat-contract-lab: all assertions passed`, `exit=0`.

- [ ] **Step 6: Wire it into the gate**

In `Makefile`, add:

```make
chat-gates:
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab
```

and append `chat-gates` to the `regression:` prerequisite list. Per the Makefile's own note, a gate nothing runs is a gate in name only.

- [ ] **Step 7: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac/Sources/ChatContractLab mac/Package.swift Makefile && \
git commit -m "test(mac): XCTest 不要の chat-contract-lab ゲートを追加

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Extract `ChatStreamBuffer`

The chunk-coalescing buffer is self-contained arithmetic tangled into a 1189-line engine. The `Task`-based timer stays on the engine (it is actor-bound scheduling); only the buffer arithmetic moves, which is the part worth testing.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/Engine/ChatStreamBuffer.swift`
- Modify: `Chat/Engine/ChatEngine.swift` — replace `pendingChunkText`/`pendingChunkTurnID` state (lines ~110-113) and the bodies of `appendStreamedChunk`/`flushPendingChunks`/`discardPendingChunks` (~933-985)
- Modify: `mac/Sources/ChatContractLab/main.swift`

**Interfaces:**
- Consumes: `expect(_:_:)` from Task 9
- Produces:
  - `struct ChatStreamBuffer` with `mutating func append(_ id: UUID, _ text: String) -> (id: UUID, text: String)?`, `mutating func take() -> (id: UUID, text: String)?`, `mutating func discard()`, `var isEmpty: Bool`
  - `append` returns a batch to publish **only** when the turn id changes (the boundary flush); otherwise `nil`.

- [ ] **Step 1: Write the failing assertions in the lab**

Replace the placeholder in `main.swift` with:

```swift
// ChatStreamBuffer — the coalescing arithmetic, independent of scheduling.
do {
    let a = UUID(), b = UUID()
    var buf = ChatStreamBuffer()

    expect(buf.isEmpty, "new buffer is empty")
    expect(buf.append(a, "he") == nil, "same-turn append returns no batch")
    expect(buf.append(a, "llo") == nil, "second same-turn append returns no batch")

    let taken = buf.take()
    expect(taken?.id == a && taken?.text == "hello", "take() returns the joined batch")
    expect(buf.isEmpty, "take() drains the buffer")
    expect(buf.take() == nil, "take() on an empty buffer returns nil")

    // A chunk for a different turn must land the previous turn's text first,
    // never append across the boundary.
    _ = buf.append(a, "first")
    let boundary = buf.append(b, "second")
    expect(boundary?.id == a && boundary?.text == "first", "turn change flushes the previous turn")
    expect(buf.take()?.text == "second", "the new turn's text is buffered, not lost")

    _ = buf.append(a, "dropme")
    buf.discard()
    expect(buf.isEmpty && buf.take() == nil, "discard() drops without publishing")
}
```

- [ ] **Step 2: Run the lab to verify it fails to compile**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: compile error — `cannot find 'ChatStreamBuffer' in scope`. That is the failing state.

- [ ] **Step 3: Implement the buffer**

Create `Chat/Engine/ChatStreamBuffer.swift`:

```swift
import Foundation

/// Accumulates streamed text deltas so they publish in batches rather than
/// per-delta.
///
/// The server emits one SSE chunk per model text delta — 5-20 characters — so
/// a normal reply arrives as a thousand-plus callbacks. Publishing each one
/// straight into `messages` cost a thousand SwiftUI invalidations, a thousand
/// `WKWebView` reloads and a thousand synchronous session-file writes, all on
/// the MainActor.
///
/// This type owns only the arithmetic. The flush *timer* stays on `ChatEngine`
/// because it is actor-bound scheduling; keeping the two apart is what makes
/// the batching rules assertable without a running app.
/// `public` so `chat-contract-lab` — a separate executable target — can assert
/// it. See Task 9's access-control note.
public struct ChatStreamBuffer {
    private var text = ""
    private var turnID: UUID?

    public init() {}

    public var isEmpty: Bool { text.isEmpty }

    /// Buffer `chunk` against `id`.
    ///
    /// - Returns: the previous turn's batch when `id` differs from the turn
    ///   currently buffered — text must never append across a turn boundary —
    ///   and `nil` otherwise.
    public mutating func append(_ id: UUID, _ chunk: String) -> (id: UUID, text: String)? {
        var flushed: (id: UUID, text: String)?
        if let current = turnID, current != id {
            flushed = take()
        }
        turnID = id
        text += chunk
        return flushed
    }

    /// Drain the buffer, returning what should be published.
    public mutating func take() -> (id: UUID, text: String)? {
        defer { text = ""; turnID = nil }
        guard !text.isEmpty, let id = turnID else { return nil }
        return (id, text)
    }

    /// Drop buffered text without publishing it. Used when the turn's content
    /// is about to be replaced wholesale by the server's final reply.
    public mutating func discard() {
        text = ""
        turnID = nil
    }
}
```

- [ ] **Step 4: Run the lab to verify it passes**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: all `ok`, `exit=0`.

- [ ] **Step 5: Rewire `ChatEngine` onto the buffer**

In `Chat/Engine/ChatEngine.swift`:

1. Replace the `pendingChunkText` and `pendingChunkTurnID` properties with `var streamBuffer = ChatStreamBuffer()`. Keep `chunkFlushTask` and `chunkCoalesceNanos` where they are.
2. Rewrite the three methods, preserving `revealedCount` accounting exactly:

```swift
func appendStreamedChunk(_ id: UUID, _ text: String) {
    if let boundary = streamBuffer.append(id, text) { publish(boundary) }
    guard chunkFlushTask == nil else { return }
    chunkFlushTask = Task { [chunkCoalesceNanos] in
        try? await Task.sleep(nanoseconds: chunkCoalesceNanos)
        guard !Task.isCancelled else { return }
        self.flushPendingChunks()
    }
}

func flushPendingChunks() {
    chunkFlushTask?.cancel()
    chunkFlushTask = nil
    guard let batch = streamBuffer.take() else { return }
    publish(batch)
}

func discardPendingChunks() {
    chunkFlushTask?.cancel()
    chunkFlushTask = nil
    streamBuffer.discard()
}

/// Append a drained batch to its turn. Incremental, not `content.count` —
/// see `revealedCount`.
private func publish(_ batch: (id: UUID, text: String)) {
    guard let idx = messages.firstIndex(where: { $0.id == batch.id }) else { return }
    messages[idx].content += batch.text
    revealedCount += batch.text.count
}
```

- [ ] **Step 6: Verify nothing else touched the old properties**

```bash
cd /Users/dinesh.malla/llm-ide/mac && \
grep -rn "pendingChunkText\|pendingChunkTurnID" Sources/ Tests/ || echo "clean"
```
Expected: `clean`. Any hit in `Tests/` must be updated to use `streamBuffer` — those tests cannot run here but must still compile.

- [ ] **Step 7: Run the full gate**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS, including the new `chat-gates`.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac && \
git commit -m "refactor(mac): チャンク合流を ChatStreamBuffer へ抽出

タイマーはエンジンに残し、算術のみを純粋型に切り出して
lab ゲートで検証可能にする。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Move `bubbleHeights` off the engine

View geometry currently lives on the engine (`ChatEngine.swift:176`) and is written by two views. When the quick-chat sheet and the menu bar are both open on the shared `.quick` engine, they write the same dictionary keyed by message id — each clobbering the other's measurement for the same message at a different width.

**Files:**
- Modify: `Chat/Engine/ChatEngine.swift` — remove `bubbleHeights`
- Create: `Chat/Views/Shared/BubbleHeightCache.swift`
- Modify: `Chat/Views/Panel/ChatMessageList.swift:673,676`
- Modify: `Chat/Views/Quick/MenuBarChatView.swift:550,553`

**Interfaces:**
- Consumes: nothing
- Produces: `@Observable final class BubbleHeightCache` with `subscript(id: UUID) -> CGFloat?` and `func height(for id: UUID, min: CGFloat) -> CGFloat`. Each view owns its own instance via `@State`.

- [ ] **Step 1: Add the assertion**

Append to `main.swift`:

```swift
// BubbleHeightCache — per-view geometry, never shared through the engine.
do {
    let cache = BubbleHeightCache()
    let id = UUID()
    expect(cache[id] == nil, "unmeasured id has no height")
    expect(cache.height(for: id, min: 24) == 24, "unmeasured id falls back to min")
    cache[id] = 80
    expect(cache.height(for: id, min: 24) == 80, "measured height wins over min")
    cache[id] = 10
    expect(cache.height(for: id, min: 24) == 24, "min floors a smaller measurement")
}
```

- [ ] **Step 2: Run the lab to verify it fails**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: compile error — `cannot find 'BubbleHeightCache' in scope`.

- [ ] **Step 3: Implement it**

Create `Chat/Views/Shared/BubbleHeightCache.swift`:

```swift
import Foundation
import SwiftUI

/// Measured transcript-bubble heights for ONE rendering surface.
///
/// This was previously `ChatEngine.bubbleHeights`, which put view geometry on
/// a shared engine: the quick-chat sheet and the menu bar render the same
/// `.quick` engine at different widths, so both wrote the same id and each
/// clobbered the other's measurement. Height is a property of a view, not of
/// a conversation — every surface owns its own cache.
/// `public` for the same reason as `ChatStreamBuffer` — see Task 9.
@Observable
public final class BubbleHeightCache {
    private var heights: [UUID: CGFloat] = [:]

    public init() {}

    public subscript(id: UUID) -> CGFloat? {
        get { heights[id] }
        set { if heights[id] != newValue { heights[id] = newValue } }
    }

    /// Measured height for `id`, floored at `min`.
    public func height(for id: UUID, min floor: CGFloat) -> CGFloat {
        Swift.max(heights[id] ?? floor, floor)
    }
}
```

- [ ] **Step 4: Run the lab to verify it passes**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: all `ok`, `exit=0`.

- [ ] **Step 5: Give each view its own cache**

In `ChatMessageList.swift` and `MenuBarChatView.swift`, add `@State private var bubbleHeights = BubbleHeightCache()` and replace `engine.bubbleHeights[...]` with `bubbleHeights[...]` / `bubbleHeights.height(for:min:)`. Then delete `var bubbleHeights: [UUID: CGFloat] = [:]` from `ChatEngine.swift`.

- [ ] **Step 6: Verify the engine no longer carries view geometry**

```bash
cd /Users/dinesh.malla/llm-ide/mac && grep -rn "engine.bubbleHeights\|\.bubbleHeights" Sources/ Tests/ | grep -v BubbleHeightCache || echo "clean"
```
Expected: `clean`.

- [ ] **Step 7: Run the full gate**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac && \
git commit -m "fix(mac): バブル高をビュー毎のキャッシュへ移す

シートとメニューバーが共有エンジン上で同じ辞書を
奪い合っていた問題を解消。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Extract `ApprovalCardSlot` — three copies to one

The approval-card block is copy-pasted verbatim into three views. Two copies carry the comment "See `ChatMessageList`'s identical block", so the duplication is documented rather than removed.

**Files:**
- Create: `Chat/Views/Shared/ApprovalCardSlot.swift`
- Modify: `Chat/Views/Panel/ChatMessageList.swift:133-162`
- Modify: `Chat/Views/Quick/MenuBarChatView.swift:477-501`
- Modify: `Chat/Views/Quick/LlmChatSheet.swift:238-262`

**Interfaces:**
- Consumes: `AgentV2Approval` (unchanged), `ToolApprovalCard`, `ApprovalQuestionCard`
- Produces: `struct ApprovalCardSlot: View` taking `approval: AgentV2Approval`, `onDecision: (AgentV2ApprovalDecision) -> Void`, `onDismiss: () -> Void`

- [ ] **Step 1: Read all three blocks and confirm they are equivalent**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Chat/Views && \
sed -n '133,162p' Panel/ChatMessageList.swift > /tmp/a.txt && \
sed -n '477,501p' Quick/MenuBarChatView.swift > /tmp/b.txt && \
sed -n '238,262p' Quick/LlmChatSheet.swift > /tmp/c.txt && \
diff /tmp/a.txt /tmp/b.txt; diff /tmp/a.txt /tmp/c.txt
```
Record every difference. Differences are **requirements for the extracted view's parameters**, not things to discard. If a difference is behavioural rather than cosmetic, STOP and report it rather than unifying it away.

- [ ] **Step 2: Create the shared slot**

Write `ApprovalCardSlot.swift` containing the union of the three blocks, with each observed difference from Step 1 expressed as a parameter with a default matching `ChatMessageList`'s behaviour (the canonical copy the other two cite).

- [ ] **Step 3: Replace all three call sites with `ApprovalCardSlot(...)`**

Delete the three inline blocks, including the two "identical block" comments that pointed at the duplication.

- [ ] **Step 4: Verify the duplication is gone**

```bash
cd /Users/dinesh.malla/llm-ide/mac && grep -rn "identical block" Sources/ || echo "clean"
```
Expected: `clean`.

- [ ] **Step 5: Run the full gate**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac && \
git commit -m "refactor(mac): 承認カードの3重複を1つに統合

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Extract `ModelPickerController` from `ChatComposer`

`ChatComposer.swift` is 927 lines doing seven things. The worst is the model picker (`:459-735`): a *view* holding `api.listProviderModels` networking, `@AppStorage` JSON persistence, and `config.defaultModelId` writes.

**Files:**
- Create: `Chat/Views/Panel/ModelPickerController.swift`
- Modify: `Chat/Views/Panel/ChatComposer.swift` — remove `:459-735`

**Interfaces:**
- Consumes: `LlmIdeAPIClient`, `AppConfig`
- Produces: `@Observable final class ModelPickerController` with `func load(api:) async`, `func addCustom(id:displayName:)`, `var models: [AIModel]`, `var isLoading: Bool`, `var error: String?`

- [ ] **Step 1: Move the picker's state, networking and persistence into the controller**

Lift `loadModels` (`:713`), `addCustomModel` (`:693-709`) and their backing state out of the `CodeAssistantPanel` extension into the new `@Observable` class. The SwiftUI menu markup stays in `ChatComposer`; only logic moves.

- [ ] **Step 2: Stop using `engine.error` as a usage-help channel**

`applyModelCommand` currently writes `engine.error` to surface `/model` usage text (`:655`, `:664`). Route that through the controller's own `error` instead, so a help string never renders as a turn failure.

- [ ] **Step 3: Verify the composer no longer holds networking or persistence**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Chat/Views/Panel && \
grep -n "listProviderModels\|AppStorage\|engine.error" ChatComposer.swift || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Confirm the file shrank below the 400-line guideline for a single concern**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Chat/Views/Panel && wc -l ChatComposer.swift ModelPickerController.swift
```
Expected: `ChatComposer.swift` materially smaller than 927.

- [ ] **Step 5: Run the full gate**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac && \
git commit -m "refactor(mac): モデル選択の通信と永続化をビューから分離

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Unify the quick-chat surfaces

`LlmChatSheet` and `MenuBarChatView` each re-implement a transcript, a bubble, a busy indicator and a send flow for the same `.quick` engine. `sendDraft` is duplicated near-verbatim (`LlmChatSheet:445-472`, `MenuBarChatView:830-891`), down to the same refusal string.

**Files:**
- Create: `Chat/Views/Quick/QuickChatSurface.swift`
- Create: `Chat/Views/Quick/QuickChatSendController.swift`
- Modify: `Chat/Views/Quick/LlmChatSheet.swift`
- Modify: `Chat/Views/Quick/MenuBarChatView.swift`

**Interfaces:**
- Consumes: `ChatEngine`, `ApprovalCardSlot` (Task 12), `BubbleHeightCache` (Task 11)
- Produces:
  - `struct QuickChatSurface: View` — transcript + composer for a `.quick` engine
  - `public final class QuickChatSendController` (public per Task 9's access note) with:
    - `public func classify(draft: String, busy: Bool) -> SendOutcome` — the pure policy the lab asserts
    - `public func send(draft: String, engine: ChatEngine) -> SendOutcome` — `classify` plus the side effect
    - `public enum SendOutcome: Equatable { case sent, refusedBusy(String), empty }` — **must** be `Equatable`, because the lab compares it with `==`

- [ ] **Step 1: Assert the send policy in the lab**

Append to `main.swift`:

```swift
// QuickChatSendController — one send policy for both quick surfaces.
do {
    let c = QuickChatSendController()
    expect(c.classify(draft: "", busy: false) == .empty, "empty draft does not send")
    expect(c.classify(draft: "  ", busy: false) == .empty, "whitespace draft does not send")
    expect(c.classify(draft: "hi", busy: false) == .sent, "idle engine accepts a draft")
    if case .refusedBusy = c.classify(draft: "hi", busy: true) {
        expect(true, "busy engine refuses with a reason")
    } else {
        expect(false, "busy engine refuses with a reason")
    }
}
```

- [ ] **Step 2: Run the lab to verify it fails**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: compile error — `cannot find 'QuickChatSendController' in scope`.

- [ ] **Step 3: Implement `classify` as the pure policy, then `send` on top of it**

The refusal string must stay exactly "Another message is still being answered" so the user-visible copy does not change.

- [ ] **Step 4: Run the lab to verify it passes**

```bash
cd /Users/dinesh.malla/llm-ide/mac && GIT_CONFIG_GLOBAL=/dev/null swift run -c release chat-contract-lab; echo "exit=$?"
```
Expected: all `ok`, `exit=0`.

- [ ] **Step 5: Build `QuickChatSurface` from `LlmChatSheet`'s renderer**

Use the sheet's transcript as the base (it is the simpler of the two), add whatever the menu bar's version does differently as parameters, and reduce both call sites to chrome — window management in `MenuBarChatWindowHandle`, sheet presentation in `LlmChatSheet`.

- [ ] **Step 6: Verify both surfaces now share one renderer**

```bash
cd /Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Chat/Views/Quick && \
wc -l LlmChatSheet.swift MenuBarChatView.swift QuickChatSurface.swift && \
grep -c "func messageRow\|func bubble\|func transcriptView" LlmChatSheet.swift MenuBarChatView.swift
```
Expected: both counts `0` — neither chrome declares its own renderer any more.

- [ ] **Step 7: Run the full gate**

```bash
cd /Users/dinesh.malla/llm-ide && make regression
```
Expected: PASS.

- [ ] **Step 8: Manual check — this task changes rendering**

Launch the app. Verify, and report the result rather than assuming:
1. Menu-bar chat opens, sends a message, streams a reply.
2. The Shell quick-chat sheet does the same.
3. Both open at once on the same `.quick` session show consistent text.
4. An approval prompt renders in both surfaces.

- [ ] **Step 9: Commit**

```bash
cd /Users/dinesh.malla/llm-ide && git add -A mac && \
git commit -m "refactor(mac): クイックチャットの二重実装を統合

シートとメニューバーを QuickChatSurface の薄い外装にする。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Deferred to the next plan

These spec items are **not** in this plan and must not be attempted here:

- `ChatEngineHooks` (collapsing the 17 injected closures) — it changes the engine's construction contract, which Phase 3's `ClaudeLink` target spike may reshape. Doing it twice is waste.
- `ChatPersistenceScheduler`, `PlanExecutionTracker`, splitting `ChatMessageList`, unifying `runTurn`/`performExternalTurn`.
- Everything in spec Phases 3–6.

## Self-Review

**Spec coverage (Phases 0–2).** Phase 0 → Task 1. Phase 1 → Tasks 2–8. Phase 2 → Tasks 9–14, minus the four extractions explicitly deferred above with a stated reason.

**Known gap, stated rather than hidden:** the spec's Phase 2 lists `ChatEngineHooks`, `ChatPersistenceScheduler` and `PlanExecutionTracker`. This plan implements neither of the latter two nor the first. That is a deliberate reduction — Task 14 already changes rendering and needs manual verification, and stacking four more engine extractions behind an unverifiable test suite raises risk faster than it raises value. They move to the next plan.

**Placeholder scan.** No TBD/TODO. Tasks 12 and 14 contain judgement steps ("record every difference", "add whatever differs as parameters") rather than final code, because the exact diff between the three duplicated blocks must be read before it can be unified — inventing that code here would be guessing. Both tasks state explicitly what to do with a difference, including when to stop.

**Type consistency.** `ChatStreamBuffer.take()` returns `(id: UUID, text: String)?` and is consumed as `batch.id`/`batch.text` in Task 10 Step 5. `BubbleHeightCache.height(for:min:)` is used with the same labels in Task 11 Step 5. `QuickChatSendController.classify(draft:busy:)` returns `SendOutcome`, matching the lab assertions. `ApprovalCardSlot` takes `approval`/`onDecision`/`onDismiss` in both its definition and its three call sites.

**Two corrections made during review, both load-bearing:**

1. **Target name.** Task 9 originally depended on `LlmIdeMac` and wrote
   `import LlmIdeMac`. `LlmIdeMac` is the *executable product* built from target
   `LlmIdeMacMain` (`Package.swift:228`); the library is **`LlmIdeMacLib`**
   (`:255`, path `Sources/LlmIdeMac`). Following the original text would have
   failed to resolve.
2. **Access control.** A separate executable target sees only `public` symbols,
   and `@testable import` is unavailable outside test targets — so the lab could
   not have asserted anything the plan extracted. Every extracted type is now
   explicitly `public` with a `public init`, and Task 9 carries the rule so later
   tasks inherit it. `SendOutcome` also had to gain `Equatable`, since the lab
   compares it with `==`.

Both were plan bugs that would have surfaced as a compile failure at Task 9
Step 3 or Task 10 Step 2 — recoverable, but they would have stalled an executor
with no context.

**Verification honesty.** No step runs `swift test`, because it does not run on this toolchain. Every assertion runs through `swift run chat-contract-lab` or `make regression`. Task 14 is marked as needing human verification because no automated check here covers rendering.
