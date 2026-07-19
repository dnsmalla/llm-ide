# Per-Section Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the 4 chat sidebar sections (Explorer, Review Conflicts, Visual, Doc Gen) its own isolated, persistent chat (one per section, survives restarts), and delete the Plans sidebar section.

**Architecture:** A new `ChatScope` enum (4 cases) keys chat persistence — one JSON file per scope at `sessions/<scope>.json`. `CodeAssistantPanel` takes a `scope` param and loads/saves/clears that one file. The global `@AppStorage` session pointer, the multi-session picker, and the launch wipe are removed. Old UUID-keyed session files are abandoned (the app already wiped them every launch).

**Tech Stack:** Swift 6 / SwiftUI / swift-testing (`@Suite`, `@Test`, `#expect`). macOS app target `mac/`.

## Global Constraints

- **No new dependencies.** Reuse existing `ChatSession`, `ChatSessionStore`, `AppJSON` coder.
- **Verify with `swift build` / `swift test`, not SourceKit alone** (SourceKit produces stale errors in this project).
- **Build/test commands:** `cd mac && swift build` and `cd mac && swift test`. Pre-warm the build before pushing; the git pre-push hook runs `swift build` + `swift test`.
- **Existing test style:** `@Suite("…", .serialized) struct …`, `@Test func …`, `#expect`, isolated temp dirs. Follow it.
- **Scope identity = file name.** A section's chat lives at `~/Library/Application Support/LLM IDE/sessions/<scope>.json`. `ChatSession` does **not** get a `scope` field (YAGNI — the file name is the identity).
- **Additive before removal.** Task 1 adds the new scope-keyed store methods alongside the old ones (overloads — no clash). Task 2 migrates the panel. Task 3 removes the now-dead old methods. Each task leaves a green build.
- **Core chat function is unchanged:** send/receive, file attach, model picker, attachments, skills, edit-acceptance mode all stay.
- **Conventional Commits, one concern per commit.** Suggested branch: `feat/per-section-chat` (create from `main` before Task 1).
- **Do not touch:** `AskAgentSheet`, `MemoryStore`, the menu bar, mobile chat, KB `/plans` data (`LlmIdeAPIClient+KB.swift:92 return r.plans`).

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `mac/Sources/LlmIdeMac/Models/ChatSession.swift` | Add `ChatScope` enum atop the file. | **Modify** |
| `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift` | Add scope-keyed `load(for:)`/`save(_:for:)`/`clear(for:)` + a test dir override; later remove dead UUID-keyed methods. | **Modify** |
| `mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift` | Unit tests for the scope-keyed store (fresh/round-trip/isolation/clear). | **Create** |
| `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` | Add `scope` param; load/save/clear by scope; remove global pointer, multi-session picker, create/switch/delete session; add Clear button. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift` | Dead after the picker is removed. | **Delete** |
| `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` | Pass `scope: .explorer`. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/ReviewView.swift` | Pass `scope: .conflicts`. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/Visual/VisualView.swift` | Pass `scope: .visual`. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/DocGen/DocGenView.swift` | Pass `scope: .docGen`. | **Modify** |
| `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` | Remove the `wipeAllForFreshLaunch()` call (chats persist across restarts). | **Modify** |
| `mac/Sources/LlmIdeMac/Services/ShellState.swift` | Remove `.plans` from `Section` + all helpers. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/AppShell.swift` | Remove `.plans` from the sidebar list + its routing case. | **Modify** |
| `mac/Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift` | Remove the "go to Plans" nav button. | **Modify** |

---

### Task 1: `ChatScope` + scope-keyed store methods (TDD, additive)

Add the new scope-keyed API alongside the existing UUID-keyed one. No existing method is removed or changed in this task — the new methods are overloads with distinct signatures, so the app stays green and the picker keeps working.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/ChatSession.swift` (add enum atop, before `struct ChatSession`)
- Modify: `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift` (add test dir override + 4 methods)
- Create: `mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift`

**Interfaces:**
- Produces: `ChatScope` enum; `ChatSessionStore.baseDirectoryOverride: URL?`, `load(for scope: ChatScope) -> ChatSession`, `save(_ session: ChatSession, for scope: ChatScope)`, `clear(for scope: ChatScope)`, `scopeFileURL(for scope: ChatScope) -> URL?`.

- [ ] **Step 1: Add `ChatScope` atop `ChatSession.swift`**

Insert immediately after the `import Foundation` line (before `/// One persisted Code Assistant…`):

```swift
/// Which sidebar section a chat belongs to. The section IS the chat
/// identity: each scope maps to exactly one persisted chat file
/// (`sessions/<scope>.json`). Add a case when a new section gets chat.
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
}
```

- [ ] **Step 2: Add a test-only base-directory override to `ChatSessionStore`**

In `ChatSessionStore.swift`, change the `baseDir` computed property (lines 15-24) so tests can redirect it. Replace the existing `baseDir` with:

```swift
    /// Test hook: when set, `baseDir` uses this instead of Application
    /// Support. Production leaves it nil. Lets unit tests run against a
    /// throwaway temp dir.
    static var baseDirectoryOverride: URL?

    private static var baseDir: URL? {
        if let override = baseDirectoryOverride { return override }
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        let dir = base.appendingPathComponent("LLM IDE", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }
```

- [ ] **Step 3: Add the scope-keyed methods**

Append this block inside `enum ChatSessionStore` (after the existing `migrateLegacy()` method, before the closing `}`):

```swift
    // MARK: - Per-section (scope-keyed) chat

    /// `sessions/<scope>.json`. Named `scopeFileURL` to avoid clashing with
    /// the legacy `fileURL(for id: UUID)` while both coexist.
    private static func scopeFileURL(for scope: ChatScope) -> URL? {
        sessionsDir?.appendingPathComponent("\(scope.rawValue).json")
    }

    /// The one chat for this section, or a fresh empty session if none is
    /// saved yet (first open). Corrupt files are quarantined like the legacy
    /// path and a fresh session is returned.
    static func load(for scope: ChatScope) -> ChatSession {
        guard let url = scopeFileURL(for: scope),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else {
            return ChatSession()
        }
        do {
            return try AppJSON.decoder.decode(ChatSession.self, from: data)
        } catch {
            log.warning("chat_session_decode_failed scope=\(scope.rawValue, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            let stamp = Int(Date().timeIntervalSince1970)
            let corrupt = url.deletingPathExtension().appendingPathExtension("corrupt-\(stamp)")
            try? FileManager.default.moveItem(at: url, to: corrupt)
            return ChatSession()
        }
    }

    /// Persist `session` as this section's chat (`sessions/<scope>.json`).
    /// Bumps `lastUsedAt` so the file reflects the last touch.
    static func save(_ session: ChatSession, for scope: ChatScope) {
        guard let url = scopeFileURL(for: scope) else { return }
        var bumped = session
        bumped.lastUsedAt = Date()
        do {
            let data = try AppJSON.encoder.encode(bumped)
            try data.write(to: url, options: .atomic)
        } catch {
            log.warning("chat_session_save_failed scope=\(scope.rawValue, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    /// Delete one section's chat file — the "Clear chat" action. The on-disk
    /// file goes away; the in-memory history is reset by the caller.
    static func clear(for scope: ChatScope) {
        guard let url = scopeFileURL(for: scope) else { return }
        try? FileManager.default.removeItem(at: url)
    }
```

- [ ] **Step 4: Write the failing tests**

Create `mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift`:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("ChatSessionStore scope-keyed", .serialized)
struct ChatSessionStoreTests {

    /// Point the store at a throwaway "LLM IDE" dir for this test.
    private func overrideDir() -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("chatstore-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = dir
        return dir
    }

    @Test func loadReturnsFreshWhenNoFile() {
        overrideDir()
        let session = ChatSessionStore.load(for: .explorer)
        #expect(session.history.isEmpty)
        #expect(session.title == "New chat")
    }

    @Test func saveRoundTripsHistory() {
        overrideDir()
        var session = ChatSessionStore.load(for: .visual)
        session.history = [.init(role: .user, content: "hello"),
                           .init(role: .assistant, content: "hi")]
        ChatSessionStore.save(session, for: .visual)

        let reloaded = ChatSessionStore.load(for: .visual)
        #expect(reloaded.history.count == 2)
        #expect(reloaded.history.first?.role == .user)
        #expect(reloaded.history.first?.content == "hello")
    }

    @Test func scopesAreIsolated() {
        overrideDir()
        var explorer = ChatSessionStore.load(for: .explorer)
        explorer.history = [.init(role: .user, content: "in explorer")]
        ChatSessionStore.save(explorer, for: .explorer)

        // Conflicts must be untouched by the explorer save.
        let conflicts = ChatSessionStore.load(for: .conflicts)
        #expect(conflicts.history.isEmpty)

        var conflictsMut = conflicts
        conflictsMut.history = [.init(role: .user, content: "in conflicts")]
        ChatSessionStore.save(conflictsMut, for: .conflicts)

        #expect(ChatSessionStore.load(for: .explorer).history.first?.content == "in explorer")
        #expect(ChatSessionStore.load(for: .conflicts).history.first?.content == "in conflicts")
    }

    @Test func clearRemovesOnlyOneScope() {
        overrideDir()
        var a = ChatSessionStore.load(for: .explorer)
        a.history = [.init(role: .user, content: "keep me")]
        ChatSessionStore.save(a, for: .explorer)
        var b = ChatSessionStore.load(for: .docGen)
        b.history = [.init(role: .user, content: "clear me")]
        ChatSessionStore.save(b, for: .docGen)

        ChatSessionStore.clear(for: .docGen)

        #expect(ChatSessionStore.load(for: .explorer).history.first?.content == "keep me")
        #expect(ChatSessionStore.load(for: .docGen).history.isEmpty)
    }
}
```

> **Note on `CodeAssistTurn.init`:** confirm the memberwise init signature `CodeAssistTurn(role:content:)` by reading `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift:16-23` before running. If the initializer requires `id:` explicitly, add `id: UUID()` to each `.init(...)` in the tests.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd mac && swift test --filter ChatSessionStoreTests`
Expected: PASS (4 tests).

- [ ] **Step 6: Build to verify the app still compiles (old methods untouched)**

Run: `cd mac && swift build`
Expected: builds clean — the new methods are additive overloads; the panel/picker are unchanged.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/ChatSession.swift mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift
git commit -m "feat(chat): add scope-keyed ChatSessionStore API + ChatScope"
```

---

### Task 2: Migrate `CodeAssistantPanel` to per-section chat

Switch the panel from the global `@AppStorage` pointer + multi-session picker to one scope-keyed chat. This removes the picker UI, the session-manager methods, and the global pointer; updates the 4 embedding sites; and stops wiping on launch so chats persist.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift:83`
- Modify: `mac/Sources/LlmIdeMac/Views/ReviewView.swift:159`
- Modify: `mac/Sources/LlmIdeMac/Views/Visual/VisualView.swift:66`
- Modify: `mac/Sources/LlmIdeMac/Views/DocGen/DocGenView.swift:47`
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift` (the `wipeAllForFreshLaunch()` call)

**Interfaces:**
- Consumes: `ChatScope` + `ChatSessionStore.load(for:)` / `save(_:for:)` / `clear(for:)` from Task 1.
- Produces: `CodeAssistantPanel(api:…, scope: ChatScope, …)` — `scope` is a required parameter.

- [ ] **Step 1: Add the `scope` parameter and drop the global pointer**

In `CodeAssistantPanel.swift`, edit the init parameter block (lines 33-39) and the `@AppStorage` line (46). Replace:

```swift
struct CodeAssistantPanel: View {
    let api: LlmIdeAPIClient
    /// When set, this file is attached automatically the first time the panel appears.
    var initialURL: URL? = nil
    /// Hide "Add from Library" from the input bar (use when file is auto-attached).
    var showFileAttachButtons: Bool = true
    /// Show Cursor-style agent + model picker row in the input bar.
    var showModelPicker: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) private var library

    @AppStorage("MEETNOTES_CURRENT_CHAT_SESSION_ID") private var currentSessionIDString: String = ""
```

with:

```swift
struct CodeAssistantPanel: View {
    let api: LlmIdeAPIClient
    /// Which section this chat belongs to — keys the persisted chat file
    /// (`sessions/<scope>.json`). Required: each embedding site passes its own.
    let scope: ChatScope
    /// When set, this file is attached automatically the first time the panel appears.
    var initialURL: URL? = nil
    /// Hide "Add from Library" from the input bar (use when file is auto-attached).
    var showFileAttachButtons: Bool = true
    /// Show Cursor-style agent + model picker row in the input bar.
    var showModelPicker: Bool = false

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) private var library
```

(The `@AppStorage` line is deleted.)

- [ ] **Step 2: Drop the picker state**

Delete these two `@State` lines (72-73):

```swift
    @State private var sessions: [ChatSession] = []
    @State private var showingSessionPicker: Bool = false
```

- [ ] **Step 3: Rewrite `handleOnAppear` (lines 292-322)**

Replace the whole method with the scope-keyed version:

```swift
    private func handleOnAppear() {
        if selectedModel.isEmpty {
            selectedModel = config.defaultModelId.isEmpty
                ? AICliTool.claudeCode.defaultModelId
                : config.defaultModelId
        }
        let session = ChatSessionStore.load(for: scope)
        history = session.history
        rebuildSentPrompts(from: session.history)
        if let url = initialURL, !didAttachInitial {
            didAttachInitial = true
            if addFile(url: url) == .added {
                autoAttachedPath = displayPath(url)
            }
        }
    }
```

- [ ] **Step 4: Point the history-change handler at the new persist method**

In `handleHistoryChange` (line 325), change:

```swift
        persistCurrentSession(history: Array(newValue.suffix(50)))
```

to:

```swift
        persistCurrentChat(history: Array(newValue.suffix(50)))
```

- [ ] **Step 5: Replace `persistCurrentSession` with `persistCurrentChat`**

Replace the `persistCurrentSession(history:)` method (lines 2565-2582) with:

```swift
    /// Persist `history` into this section's chat file, deriving a title
    /// from the first user turn if it's still "New chat".
    private func persistCurrentChat(history: [LlmIdeAPIClient.CodeAssistTurn]) {
        var session = ChatSessionStore.load(for: scope)
        session.history = history
        if session.title == "New chat" || session.title.isEmpty {
            if let firstUser = history.first(where: { $0.role == .user }) {
                let raw = firstUser.content
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !raw.isEmpty {
                    session.title = String(raw.prefix(40))
                }
            }
        }
        ChatSessionStore.save(session, for: scope)
    }
```

- [ ] **Step 6: Replace `createNewSession` with `clearCurrentChat`**

Replace the `createNewSession()` method (lines 2598-2622) with:

```swift
    /// Clear this section's chat: delete the file and reset all composer
    /// + agent state. (Replaces the old "new session" action — there is now
    /// exactly one chat per section.)
    private func clearCurrentChat() {
        ChatSessionStore.clear(for: scope)
        resetActiveTurnState()
        history = []
        sentPrompts = []; historyIndex = nil; draftStash = ""
        draft = ""
        attachments.removeAll()
        selectedSkills.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        pendingTool = nil
        error = nil
        agentSessionId = UUID().uuidString
        agentPendingTasks = []
        agentIsAutonomous = false
        agentStopRequested = false
    }
```

- [ ] **Step 7: Delete `switchSession` and `deleteSession`**

Delete the `switchSession(to id: UUID)` method (lines 2624-2646) and the `deleteSession(_ id: UUID)` method (lines 2648-2666) entirely.

- [ ] **Step 8: Replace the dropdown button + popover with a Clear button**

Delete the three view members `sessionDropdownButton` (lines 795-826), `currentSessionTitle` (lines 828-834), and `sessionPickerPopover` (lines 836-887). In their place add:

```swift
    /// Header button: wipe this section's chat (replaces the multi-session
    /// picker — there's one chat per section now).
    private var clearChatButton: some View {
        Button {
            clearCurrentChat()
        } label: {
            Image(systemName: "trash")
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .foregroundStyle(theme.current.textMuted)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Clear this section's chat")
        .accessibilityLabel("Clear chat")
        .disabled(history.isEmpty)
    }
```

- [ ] **Step 9: Swap the header reference from the dropdown to the Clear button**

Find the single place the header uses the dropdown. Run:

```bash
cd mac && grep -n "sessionDropdownButton" Sources/LlmIdeMac/Views/CodeAssistantPanel.swift
```

At that call site (the header bar `HStack`), replace `sessionDropdownButton` with `clearChatButton`. (If the surrounding `HStack` had spacing/modifiers tuned for the wider dropdown button, leave them — the trash button inherits them.)

- [ ] **Step 10: Pass `scope` from each of the 4 embedding sites**

At each `CodeAssistantPanel(...)` call site, add the `scope:` argument matching its section. The four sites and their scopes:

- `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift:83` → `CodeAssistantPanel(api: api, scope: .explorer, …)`
- `mac/Sources/LlmIdeMac/Views/ReviewView.swift:159` → `CodeAssistantPanel(api: api, scope: .conflicts, …)`
- `mac/Sources/LlmIdeMac/Views/Visual/VisualView.swift:66` → `CodeAssistantPanel(api: api, scope: .visual, …)`
- `mac/Sources/LlmIdeMac/Views/DocGen/DocGenView.swift:47` → `CodeAssistantPanel(…, scope: .docGen, …)`

Insert `scope: <case>,` as the second argument (right after `api:`) at each site. The other existing arguments (`initialURL`, `showFileAttachButtons`, `showModelPicker`) stay.

- [ ] **Step 11: Stop wiping chats on launch**

`LlmIdeMacApp.init()` calls `ChatSessionStore.wipeAllForFreshLaunch()` (around `LlmIdeMacApp.swift:61`) on every launch — that's why chats don't survive restarts today. Find and delete that one call (do **not** remove the method itself — Task 3 does that):

```bash
cd mac && grep -n "wipeAllForFreshLaunch" Sources/LlmIdeMac/LlmIdeMacApp.swift
```

Delete the matched line `ChatSessionStore.wipeAllForFreshLaunch()`. Leave the rest of `init()` (and the `.task` bootstrap block) untouched.

- [ ] **Step 12: Build to verify**

Run: `cd mac && swift build`
Expected: builds clean. (The old `ChatSessionStore` methods — `listSessions`, `load(id:)`, `delete(id:)`, `save(_:)`, `migrateLegacy`, `wipeAllForFreshLaunch` — are now unused by the panel but still defined; Task 3 removes them.)

- [ ] **Step 13: Run the store tests + the existing chat-related tests**

Run: `cd mac && swift test`
Expected: PASS — including `ChatSessionStoreTests` and the pre-existing suite (no regressions).

- [ ] **Step 14: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift \
        mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift \
        mac/Sources/LlmIdeMac/Views/ReviewView.swift \
        mac/Sources/LlmIdeMac/Views/Visual/VisualView.swift \
        mac/Sources/LlmIdeMac/Views/DocGen/DocGenView.swift \
        mac/Sources/LlmIdeMac/LlmIdeMacApp.swift
git commit -m "feat(chat): per-section chat — one persistent chat per scope"
```

---

### Task 3: Remove the dead UUID-keyed store code + `SessionRow`

After Task 2, nothing calls the legacy multi-session API. Remove it and the orphaned picker row view.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift`
- Delete: `mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift`

- [ ] **Step 1: Confirm zero callers of the legacy API**

Run:

```bash
cd mac && grep -rn "listSessions\|\.load(id:\|delete(id:\|wipeAllForFreshLaunch\|migrateLegacy\|ChatSessionStore.save(" Sources Tests
```

Expected: the only hits are the **definitions** inside `ChatSessionStore.swift` (and the new `save(_:for:)` overload calls in the panel). There must be **no** callers of `listSessions`, `load(id:)`, `delete(id:)`, `wipeAllForFreshLaunch`, or `migrateLegacy`. If any caller remains, stop and migrate it first.

- [ ] **Step 2: Delete the dead methods from `ChatSessionStore.swift`**

Remove these members from `enum ChatSessionStore`:
- `fileURL(for id: UUID)` (lines 35-37)
- `listSessions()` (lines 44-62)
- `load(id: UUID)` (lines 64-77)
- the legacy `save(_ session: ChatSession)` (lines 81-91) — keep the new `save(_:for:)`
- `delete(id: UUID)` (lines 93-96)
- `wipeAllForFreshLaunch()` (lines 111-120)
- `migrateLegacy()` (lines 122-147, including the `// MARK: - Legacy migration` comment)

Keep: `baseDirectoryOverride`, `baseDir`, `sessionsDir`, `clear()` (sign-out still uses it), and the new `scopeFileURL(for:)` / `load(for:)` / `save(_:for:)` / `clear(for:)`.

- [ ] **Step 3: Delete `SessionRow.swift`**

```bash
cd mac && git rm Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift
```

- [ ] **Step 4: Build + full test**

Run: `cd mac && swift build && swift test`
Expected: builds clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift
git commit -m "refactor(chat): remove dead multi-session store API + SessionRow"
```

---

### Task 4: Delete the Plans sidebar section

Remove `.plans` from the section enum and every reference. `ReviewView` stays (it now serves `.conflicts` only).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift`

- [ ] **Step 1: Remove `.plans` from `ShellState.Section`**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`, remove the `plans` case from each of these (use the line numbers from the start of this plan as a guide, then verify visually):
- the enum case list (line 9): delete `plans, `
- `var label` (line 19): delete `case .plans:     return "Plans"`
- `var systemImage` (line 39): delete `case .plans:     return "doc.text.magnifyingglass"`
- the visible-sections list (line 59): delete `.plans, `
- the string-init `case "plan":` (line 100): delete `case "plan":       self = .plans`
- the section color (line 120): delete `case .plans:      return Color(red: 0.30, green: 0.65, blue: 0.55) // teal-green`

After editing, run `cd mac && grep -n "plans" Sources/LlmIdeMac/Services/ShellState.swift` — expected: no hits (the enum, label, icon, list, string-init, and color are all the `.plans` references there).

- [ ] **Step 2: Remove `.plans` from the sidebar list and routing in `AppShell.swift`**

In `mac/Sources/LlmIdeMac/Views/AppShell.swift`:
- line 319 (the sidebar section list): delete `.plans, `
- line 436: delete `case .plans:     ReviewView(api: api, config: .docs)` (leave the `case .conflicts:` line untouched)

- [ ] **Step 3: Remove the meeting → Plans navigation button**

Read `mac/Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift` around line 270:

```bash
cd mac && sed -n '258,280p' Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift
```

The button at `:270` (`Button(action: { shell.section = .plans }) { … }`) navigates from a meeting detail to the now-deleted Plans section. Remove that `Button { … }` (and, if it was the only child of an enclosing `HStack`/row, remove the now-empty container too). Do not touch unrelated buttons in the same view.

- [ ] **Step 4: Build to verify (the compiler finds any missed `.plans` reference)**

Run: `cd mac && swift build`
Expected: builds clean. If the compiler reports a missing `.plans` case elsewhere (e.g. a settings toggle, a default-section constant, a deep link), remove/adjust that reference too — these are exactly the stragglers the switch-statements were warning about.

- [ ] **Step 5: Confirm no dangling `.plans` references**

Run:

```bash
cd mac && grep -rn "\.plans\b" Sources | grep -v "generatePlan\|generate-plan\|planStatus\|updatePlanStatus\|PlanStatus\|/plans\|plan_\|r\.plans"
```

Expected: empty (the KB `r.plans` at `LlmIdeAPIClient+KB.swift:92` is intentionally excluded and stays).

- [ ] **Step 6: Run the full test suite**

Run: `cd mac && swift test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ShellState.swift \
        mac/Sources/LlmIdeMac/Views/AppShell.swift \
        mac/Sources/LlmIdeMac/Views/Library/MeetingDetailView.swift
git commit -m "refactor(shell): remove the Plans sidebar section"
```

---

### Task 5: Full verification + smoke notes

**Files:** none (verification only).

- [ ] **Step 1: Clean build + full test run**

Run: `cd mac && swift build && swift test`
Expected: builds clean; all tests pass (existing suite + `ChatSessionStoreTests`).

- [ ] **Step 2: Confirm no dangling legacy chat symbols**

Run:

```bash
cd mac && grep -rn "MEETNOTES_CURRENT_CHAT_SESSION_ID\|currentSessionIDString\|showingSessionPicker\|sessionDropdownButton\|sessionPickerPopover\|createNewSession\|switchSession\|deleteSession" Sources Tests
```

Expected: empty (all removed by Tasks 2-3).

- [ ] **Step 3: Manual smoke (run the app)**

Build the app via the project's build script (per project memory, the raw `.build` binary won't run the auto-updater — use `build_app.sh`):

```bash
cd mac && ./build_app.sh && open build/Release/LlmIdeMac.app   # confirm exact path from build_app.sh
```

Then verify:
- Explorer, Review Conflicts, Visual, Doc Gen each show **independent** chats: send a message in Explorer, switch to Visual — Visual's chat is empty/different.
- Quit and reopen the app — each section's chat is restored (persists across restarts).
- The "Clear chat" (trash) button in a section's header wipes only that section's chat.
- No "Plans" item in the sidebar; navigating from a meeting detail no longer offers a broken Plans target.
- The multi-session picker is gone; send/receive, file attach, model picker still work.

- [ ] **Step 4: Commit any smoke-fixes, then push (ask first)**

```bash
git add -A
git commit -m "test(chat): verification fixes"   # only if needed
```

Pre-warm the build before pushing — the pre-push hook runs `swift build` + `swift test`. Push only after the user confirms.

---

## Self-Review notes

- **Spec coverage:** Task 1 = `ChatScope` + scope-keyed store. Task 2 = panel wiring (scope param, load/save/clear, remove pointer + picker + create/switch/delete, Clear button) + 4 embedding sites + persistence (remove wipe call). Task 3 = dead-code removal (`listSessions`/`load(id:)`/`delete(id:)`/legacy `save`/`wipeAllForFreshLaunch`/`migrateLegacy`) + `SessionRow`. Task 4 = Plans deletion (enum + label + icon + list + string-init + color, AppShell sidebar + routing, MeetingDetailView button). Task 5 = verify. Every spec section maps to a task. Decision "no `ChatSession.scope` field" (YAGNI — the file name is the identity) is a plan-level simplification of the spec's "add `scope` field"; functionally identical and leaner.
- **Type consistency:** `ChatScope` cases (`explorer, conflicts, visual, docGen`) are used identically in Task 1 (enum + store) and Task 2 (panel param + 4 sites). Store API names — `load(for:)`, `save(_:for:)`, `clear(for:)`, `baseDirectoryOverride`, `scopeFileURL(for:)` — match across Task 1 (definition), Task 2 (panel calls), and the tests.
- **Additive-then-remove ordering** keeps every task's build green: Task 1 adds overloads (no clash with `save(_:)`/`load(id:)`/`clear()`/`fileURL(for id:)`); Task 2 migrates callers; Task 3 removes the dead originals.
- **Known follow-up (out of scope):** `ReviewView`'s `.docs` config is now unused (only `.conflicts` remains) — a future cleanup can drop it. Old UUID-named session files orphaned on disk are ignored by the scope-keyed loader; a one-time sweep is optional.
