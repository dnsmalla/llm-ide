# Cursor-Style Per-Section Chat History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Cursor-style + New chat + history popover in the Mac app, with UUID multi-session storage isolated per `ChatScope`, replacing one-file-per-scope `sessions/<scope>.json`.

**Architecture:** Each chat is `sessions/<uuid>.json` with a `scope` field. `ChatSessionStore` lists/saves/deletes by UUID and filters by scope. Legacy `sessions/<scope>.json` migrates once then is deleted. `CodeAssistantPanel` keeps a per-scope current-session pointer in UserDefaults and restores the old session-picker popover + `SessionRow`.

**Tech Stack:** SwiftUI, Foundation (FileManager + Codable JSON), UserDefaults, XCTest (minimal test target restored for the store only).

**Spec:** [`docs/superpowers/specs/2026-07-21-cursor-style-chat-history-design.md`](../specs/2026-07-21-cursor-style-chat-history-design.md)

---

## File structure

| File | Responsibility |
|------|----------------|
| `mac/Sources/LlmIdeMac/Models/ChatSession.swift` | `ChatScope` + `ChatSession` with `scope`; decode orphans without scope |
| `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift` | UUID CRUD, scoped list, migration, sign-out clear |
| `mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift` | Popover row UI (restore) |
| `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` | Picker UI + create/switch/delete; stop using `load(for:)` / `save(_:for:)` |
| `mac/Package.swift` | Re-add `LlmIdeMacTests` target |
| `mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift` | Store + migration tests |

---

### Task 1: Add `scope` to `ChatSession`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/ChatSession.swift`

- [ ] **Step 1: Update the model**

Replace the `ChatSession` struct so it includes `scope`, defaults it in `init`, and treats missing `scope` on decode as optional (nil → caller treats as orphan). Use this exact shape:

```swift
struct ChatSession: Identifiable, Codable, Equatable {
    var storeVersion: Int = 1
    let id: UUID
    /// Section this chat belongs to. Nil only when decoding legacy UUID
    /// files written before scope existed — those are orphans and must not
    /// appear in `list(for:)`.
    var scope: ChatScope?
    var title: String
    let createdAt: Date
    var lastUsedAt: Date
    var history: [LlmIdeAPIClient.CodeAssistTurn]

    init(id: UUID = UUID(),
         scope: ChatScope,
         title: String = "New chat",
         createdAt: Date = Date(),
         lastUsedAt: Date = Date(),
         history: [LlmIdeAPIClient.CodeAssistantTurn] = []) {
        self.id = id
        self.scope = scope
        self.title = title
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.history = history
    }

    enum CodingKeys: String, CodingKey {
        case storeVersion, id, scope, title, createdAt, lastUsedAt, history
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.storeVersion = (try? c.decode(Int.self, forKey: .storeVersion)) ?? 1
        self.id = try c.decode(UUID.self, forKey: .id)
        self.scope = try? c.decode(ChatScope.self, forKey: .scope)
        self.title = try c.decode(String.self, forKey: .title)
        self.createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.lastUsedAt = try c.decode(Date.self, forKey: .lastUsedAt)
        self.history = try c.decode([LlmIdeAPIClient.CodeAssistantTurn].self, forKey: .history)
    }
}
```

Keep the existing `ChatScope` enum above this struct unchanged:

```swift
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
}
```

- [ ] **Step 2: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/ChatSession.swift
git commit -m "$(cat <<'EOF'
feat(mac): add ChatScope to ChatSession for multi-session history

EOF
)"
```

---

### Task 2: Rewrite `ChatSessionStore` (UUID + migrate)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift`

- [ ] **Step 1: Replace the store implementation**

Rewrite `ChatSessionStore` to this API (keep `baseDirectoryOverride`, `baseDir`, `sessionsDir`, logging, and corrupt-quarantine patterns). Remove live use of `sessions/<scope>.json` except migration:

```swift
enum ChatSessionStore {
    // ... existing log + baseDirectoryOverride + baseDir + sessionsDir ...

    private static func fileURL(for id: UUID) -> URL? {
        sessionsDir?.appendingPathComponent("\(id.uuidString).json")
    }

    private static func legacyScopeFileURL(for scope: ChatScope) -> URL? {
        sessionsDir?.appendingPathComponent("\(scope.rawValue).json")
    }

    /// List sessions for `scope`, newest `lastUsedAt` first. Skips orphans
    /// (decoded files with nil scope) and non-matching scopes.
    static func list(for scope: ChatScope) -> [ChatSession] {
        guard let dir = sessionsDir,
              let contents = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [ChatSession] = []
        for url in contents where url.pathExtension == "json" {
            // Skip legacy scope filenames — migration owns those.
            let name = url.deletingPathExtension().lastPathComponent
            if ChatScope(rawValue: name) != nil { continue }
            guard let data = try? Data(contentsOf: url) else { continue }
            do {
                let s = try AppJSON.decoder.decode(ChatSession.self, from: data)
                if s.scope == scope { out.append(s) }
            } catch {
                quarantine(url, error: error)
            }
        }
        return out.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    static func load(id: UUID) -> ChatSession? {
        guard let url = fileURL(for: id),
              FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else { return nil }
        do {
            return try AppJSON.decoder.decode(ChatSession.self, from: data)
        } catch {
            quarantine(url, error: error)
            return nil
        }
    }

    static func save(_ session: ChatSession) {
        guard session.scope != nil, let url = fileURL(for: session.id) else { return }
        var bumped = session
        bumped.lastUsedAt = Date()
        do {
            let data = try AppJSON.encoder.encode(bumped)
            try data.write(to: url, options: .atomic)
        } catch {
            log.warning("chat_session_save_failed id=\(session.id.uuidString, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        }
    }

    static func delete(id: UUID) {
        guard let url = fileURL(for: id) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Delete every UUID session whose scope matches (not the legacy file).
    static func clear(for scope: ChatScope) {
        for s in list(for: scope) { delete(id: s.id) }
    }

    /// Sign-out: wipe the whole sessions directory.
    static func clear() {
        guard let dir = sessionsDir else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    /// If `sessions/<scope>.json` exists, convert once to a UUID file with
    /// `scope` set, delete the legacy file, and return the migrated session.
    /// Idempotent when no legacy file remains.
    static func migrateScopeFileIfNeeded(for scope: ChatScope) -> ChatSession? {
        guard let legacy = legacyScopeFileURL(for: scope),
              FileManager.default.fileExists(atPath: legacy.path) else { return nil }
        guard let data = try? Data(contentsOf: legacy) else {
            try? FileManager.default.removeItem(at: legacy)
            return nil
        }
        do {
            var session = try AppJSON.decoder.decode(ChatSession.self, from: data)
            session.scope = scope
            save(session)
            try? FileManager.default.removeItem(at: legacy)
            return session
        } catch {
            quarantine(legacy, error: error)
            return nil
        }
    }

    private static func quarantine(_ url: URL, error: Error) {
        log.warning("chat_session_decode_failed file=\(url.lastPathComponent, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
        let stamp = Int(Date().timeIntervalSince1970)
        let corrupt = url.deletingPathExtension().appendingPathExtension("corrupt-\(stamp)")
        try? FileManager.default.moveItem(at: url, to: corrupt)
    }
}
```

Delete the old methods entirely: `load(for:)`, `save(_:for:)`, `scopeFileURL(for:)` (replaced by `legacyScopeFileURL`).

- [ ] **Step 2: Fix compile breaks temporarily**

`CodeAssistantPanel` still calls the old API. Add thin temporary shims **only if needed to keep the tree building while Task 4 lands**, otherwise leave compile errors and fix in Task 4 in the same working session. Prefer fixing the panel in Task 4 immediately after this commit lands in the same branch work — do not leave shims in the final code.

If committing store alone first, keep these deprecated wrappers for one commit only:

```swift
// TEMP — remove in Task 4
static func load(for scope: ChatScope) -> ChatSession {
    _ = migrateScopeFileIfNeeded(for: scope)
    if let first = list(for: scope).first { return first }
    let fresh = ChatSession(scope: scope)
    save(fresh)
    return fresh
}

static func save(_ session: ChatSession, for scope: ChatScope) {
    var s = session
    s.scope = scope
    save(s)
}
```

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift
git commit -m "$(cat <<'EOF'
feat(mac): UUID multi-session ChatSessionStore with scope migrate

EOF
)"
```

---

### Task 3: Restore test target + store tests

**Files:**
- Modify: `mac/Package.swift`
- Create: `mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift`
- Delete or keep: `mac/Tests/LlmIdeMacTests/README-truncated-tests.md` (update to note store tests are back)

- [ ] **Step 1: Re-add the test target in `Package.swift`**

Inside `targets:`, after the executable target, add:

```swift
,
.testTarget(
    name: "LlmIdeMacTests",
    dependencies: ["LlmIdeMac"],
    path: "Tests/LlmIdeMacTests"
)
```

**Note:** `LlmIdeMac` is currently an `.executableTarget`. XCTest cannot depend on an executable target. If `swift test` fails with that error, convert the app code to a `.target(name: "LlmIdeMacLib", ...)` + thin `.executableTarget` that depends on it — **only if required**. Prefer the smaller fix first: make a `.target` named `LlmIdeMac` for sources and an executable `LlmIdeMacApp` entry — check how the Xcode/build scripts invoke the product before renaming.

If restructuring the package is too large for this feature, skip automated tests and run the manual checklist in Task 6; leave a comment in the plan commit that store tests are blocked on package layout. **Do not invent a fake green CI.**

Practical fallback (recommended if executable-target blocks tests): write `ChatSessionStoreTests.swift` as documentation of expected cases and verify with a one-off script under `mac/Scripts/verify-chat-session-store.swift` that imports nothing from the app — **not ideal**. Best path: extract store+model into testability without full app restructure by keeping tests deferred and relying on manual app verification (Task 6). Mark this task's automated run as:

```bash
cd mac && swift test --filter ChatSessionStoreTests
```

Expected: PASS — or SKIP with documented package limitation; then proceed.

- [ ] **Step 2: Write tests (when target works)**

```swift
import XCTest
@testable import LlmIdeMac

final class ChatSessionStoreTests: XCTestCase {
    var tmp: URL!

    override func setUp() {
        tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-store-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
    }

    override func tearDown() {
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    func testListFiltersByScopeAndSorts() {
        var a = ChatSession(scope: .explorer, title: "A")
        a.lastUsedAt = Date().addingTimeInterval(-100)
        var b = ChatSession(scope: .explorer, title: "B")
        b.lastUsedAt = Date()
        let other = ChatSession(scope: .visual, title: "V")
        ChatSessionStore.save(a)
        ChatSessionStore.save(b)
        ChatSessionStore.save(other)
        let list = ChatSessionStore.list(for: .explorer)
        XCTAssertEqual(list.map(\.title), ["B", "A"])
    }

    func testSaveLoadDeleteRoundTrip() {
        let s = ChatSession(scope: .conflicts, title: "X")
        ChatSessionStore.save(s)
        XCTAssertEqual(ChatSessionStore.load(id: s.id)?.title, "X")
        ChatSessionStore.delete(id: s.id)
        XCTAssertNil(ChatSessionStore.load(id: s.id))
    }

    func testMigrateScopeFileOnce() throws {
        let legacyDir = tmp.appendingPathComponent("LLM IDE/sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: legacyDir, withIntermediateDirectories: true)
        var legacy = ChatSession(scope: .explorer, title: "Old", history: [])
        // Write as legacy filename with scope stripped from meaning — file name is explorer.json
        let url = legacyDir.appendingPathComponent("explorer.json")
        let data = try AppJSON.encoder.encode(legacy)
        try data.write(to: url)
        let migrated = ChatSessionStore.migrateScopeFileIfNeeded(for: .explorer)
        XCTAssertEqual(migrated?.title, "Old")
        XCTAssertEqual(migrated?.scope, .explorer)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertNil(ChatSessionStore.migrateScopeFileIfNeeded(for: .explorer))
        XCTAssertEqual(ChatSessionStore.list(for: .explorer).count, 1)
    }

    func testClearForScopeLeavesOthers() {
        ChatSessionStore.save(ChatSession(scope: .explorer, title: "E"))
        ChatSessionStore.save(ChatSession(scope: .visual, title: "V"))
        ChatSessionStore.clear(for: .explorer)
        XCTAssertTrue(ChatSessionStore.list(for: .explorer).isEmpty)
        XCTAssertEqual(ChatSessionStore.list(for: .visual).count, 1)
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add mac/Package.swift mac/Tests/LlmIdeMacTests/ChatSessionStoreTests.swift
git commit -m "$(cat <<'EOF'
test(mac): cover scoped ChatSessionStore list/migrate/clear

EOF
)"
```

---

### Task 4: Restore `SessionRow` + wire panel session picker

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`

- [ ] **Step 1: Restore `SessionRow.swift`**

Create the file with the pre-removal implementation (title, relative time, hover trash). Full contents:

```swift
import SwiftUI

/// One row inside the session-picker popover in CodeAssistantPanel.
struct SessionRow: View {
    let session: ChatSession
    let isActive: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var hovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 8) {
                Text(session.title.isEmpty ? "New chat" : session.title)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(theme.current.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                if hovering {
                    Button(action: onDelete) {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.current.danger.opacity(0.85))
                            .padding(4)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete this chat")
                } else {
                    Text(Self.relativeLabel(for: session.lastUsedAt))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isActive ? theme.current.accent.opacity(0.10) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    private static func relativeLabel(for date: Date) -> String {
        let cal = Calendar.current
        let now = Date()
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: date, to: now).day ?? 0
        if days < 7 { return "\(days)d ago" }
        return AppDateFormatter.monthDay(date)
    }
}
```

- [ ] **Step 2: Add panel state**

Near other `@State` / storage on `CodeAssistantPanel` (after `history`):

```swift
@State private var sessions: [ChatSession] = []
@State private var showingSessionPicker = false
@State private var currentSessionIDString: String = ""
```

Update the `scope` doc comment from `sessions/<scope>.json` to UUID multi-session keyed by `scope` field.

- [ ] **Step 3: Replace header trailing controls**

In `header`, replace `clearChatButton` alone with:

```swift
Spacer(minLength: 4)
sessionDropdownButton
clearChatButton
```

Add `sessionDropdownButton`, `currentSessionTitle`, `sessionPickerPopover` from the pre-removal panel (git commit parent of `48f3104`), but change every `ChatSessionStore.listSessions()` to `ChatSessionStore.list(for: scope)` and keep popover width 320 / maxHeight 320.

- [ ] **Step 4: Rewrite lifecycle + persistence**

Replace `handleOnAppear` session load block with:

```swift
_ = ChatSessionStore.migrateScopeFileIfNeeded(for: scope)
refreshSessions()
let pointerKey = "chat.current.\(scope.rawValue)"
if currentSessionIDString.isEmpty {
    currentSessionIDString = UserDefaults.standard.string(forKey: pointerKey) ?? ""
}
if let cur = UUID(uuidString: currentSessionIDString),
   let session = ChatSessionStore.load(id: cur),
   session.scope == scope {
    history = session.history
    rebuildSentPrompts(from: session.history)
} else if let newest = sessions.first {
    currentSessionIDString = newest.id.uuidString
    history = newest.history
    rebuildSentPrompts(from: newest.history)
    UserDefaults.standard.set(currentSessionIDString, forKey: pointerKey)
} else {
    let fresh = ChatSession(scope: scope)
    ChatSessionStore.save(fresh)
    currentSessionIDString = fresh.id.uuidString
    history = []
    UserDefaults.standard.set(currentSessionIDString, forKey: pointerKey)
    refreshSessions()
}
```

(Keep the existing model-default + voice/mobile setup in `handleOnAppear`.)

Replace `persistCurrentChat` with:

```swift
private func persistCurrentChat(history: [LlmIdeAPIClient.CodeAssistantTurn]) {
    guard let id = UUID(uuidString: currentSessionIDString) else { return }
    var session = ChatSessionStore.load(id: id) ?? ChatSession(id: id, scope: scope)
    session.scope = scope
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
    ChatSessionStore.save(session)
    refreshSessions()
}

private func refreshSessions() {
    sessions = ChatSessionStore.list(for: scope)
}

private func rememberCurrentPointer() {
    UserDefaults.standard.set(currentSessionIDString, forKey: "chat.current.\(scope.rawValue)")
}
```

- [ ] **Step 5: Session actions**

Replace `clearCurrentChat` usage for header trash with delete-current semantics. Implement:

```swift
private func createNewSession() {
    // No-op if already on an empty New chat
    if history.isEmpty {
        let title = sessions.first(where: { $0.id.uuidString == currentSessionIDString })?.title ?? "New chat"
        if title == "New chat" || title.isEmpty { return }
    }
    persistCurrentChat(history: Array(history.suffix(50)))
    resetActiveTurnState()
    let fresh = ChatSession(scope: scope)
    ChatSessionStore.save(fresh)
    currentSessionIDString = fresh.id.uuidString
    rememberCurrentPointer()
    refreshSessions()
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

private func switchSession(to id: UUID) {
    guard id.uuidString != currentSessionIDString else { return }
    guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return }
    persistCurrentChat(history: Array(history.suffix(50)))
    resetActiveTurnState()
    currentSessionIDString = id.uuidString
    rememberCurrentPointer()
    history = session.history
    rebuildSentPrompts(from: session.history)
    draft = ""
    attachments.removeAll()
    selectedSkills.removeAll()
    autoAttachedPath = nil
    attachNotice = nil
    pendingTool = nil
    error = nil
    ChatSessionStore.save(session)
    refreshSessions()
}

private func deleteSession(_ id: UUID) {
    if id.uuidString == currentSessionIDString { resetActiveTurnState() }
    ChatSessionStore.delete(id: id)
    refreshSessions()
    if id.uuidString == currentSessionIDString {
        if let next = sessions.first {
            currentSessionIDString = next.id.uuidString
            rememberCurrentPointer()
            history = next.history
            rebuildSentPrompts(from: next.history)
        } else {
            // Mint empty — bypass empty no-op by clearing pointer first
            currentSessionIDString = ""
            let fresh = ChatSession(scope: scope)
            ChatSessionStore.save(fresh)
            currentSessionIDString = fresh.id.uuidString
            rememberCurrentPointer()
            refreshSessions()
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
    }
}

private func clearCurrentChat() {
    guard let id = UUID(uuidString: currentSessionIDString) else {
        createNewSession()
        return
    }
    deleteSession(id)
}
```

Update `clearChatButton` help/accessibility to “Delete current chat” and enable when `!history.isEmpty || sessions.count > 1`.

Remove any temporary `load(for:)` / `save(_:for:)` shims from Task 2 once the panel compiles against the new API only.

- [ ] **Step 6: Build**

```bash
cd mac && swift build
```

Expected: build succeeds with no errors related to `ChatSession` / `ChatSessionStore` / `SessionRow`.

- [ ] **Step 7: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/SessionRow.swift \
        mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift \
        mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift
git commit -m "$(cat <<'EOF'
feat(mac): Cursor-style New chat + history picker per section

EOF
)"
```

---

### Task 5: Grep cleanup + docs touch

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-per-section-chat-design.md` (add a one-line supersession note at top)
- Grep the mac sources for leftover `load(for:`, `save(.*for:`, `sessions/<scope>`, `listSessions`

- [ ] **Step 1: Grep and fix leftovers**

```bash
rg "load\\(for:|save\\(.*for:|listSessions|scopeFileURL|sessions/<scope>" mac/Sources mac/Tests docs/superpowers
```

Expected: only historical mentions in the 2026-07-19 spec (plus supersession note) and this plan/spec.

Add at top of `docs/superpowers/specs/2026-07-19-per-section-chat-design.md`:

```markdown
> **Superseded (storage/UI):** Multi-session UUID history per scope — see `2026-07-21-cursor-style-chat-history-design.md`. Per-section isolation and Plans removal remain in effect.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-19-per-section-chat-design.md
git commit -m "$(cat <<'EOF'
docs(chat): note per-section chat storage superseded by multi-session

EOF
)"
```

---

### Task 6: Manual verification in the Mac app

- [ ] **Step 1: Run the app**

```bash
cd mac && swift build && # launch via your usual method, e.g. open the built app or Xcode Run
```

- [ ] **Step 2: Checklist**

- [ ] Explorer: open history popover → **+ New chat** appears
- [ ] Send a message → title updates; New chat creates a second row; old messages remain when switching back
- [ ] Conflicts / Visual / Doc Gen each have **separate** lists (no cross-bleed)
- [ ] Header trash deletes current; row trash deletes that row; deleting last mints empty chat
- [ ] Empty “New chat” + New again does **not** add duplicate rows
- [ ] Quit and relaunch → histories + last-active per section restore
- [ ] If an old `sessions/explorer.json` existed, it appears once as a UUID session and the legacy file is gone

- [ ] **Step 3: Final commit only if verification prompted fixes**

If bugs found, fix + commit with `fix(mac): …` messages; otherwise done.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| UUID files + `scope` field | 1, 2 |
| list/save/load/delete/clear(for:)/clear() | 2 |
| migrate `<scope>.json` then delete | 2, 3 |
| Popover + New chat + SessionRow | 4 |
| Header trash + row trash | 4 |
| Per-scope pointer | 4 |
| Empty New chat no-op | 4 |
| Sign-out wipe | unchanged `clear()` in AccountSettings |
| Persist across restart | 4 + 6 |
| Remove one-file-per-scope live path | 2, 5 |
| Tests | 3 (or manual 6 if package blocks) |

## Placeholder / consistency check

- API names consistent: `list(for:)`, `migrateScopeFileIfNeeded(for:)`, `delete(id:)`, `ChatSession(scope:)`.
- No TBD steps remain.
- Panel must not call removed `load(for:)` / `save(_:for:)` after Task 4.
