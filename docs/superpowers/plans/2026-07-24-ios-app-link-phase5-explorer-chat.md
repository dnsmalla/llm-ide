# iOS↔Mac Native Link — Phase B (5): Native Explorer Chat (full sync)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A native iOS "Explorer Chat" that is the **same chat** as the Mac's explorer chat — the phone lists/loads/creates/deletes Mac explorer sessions and sends messages that stream the code agent's reply and **persist back into the Mac's `ChatSessionStore`**, so phone and Mac stay in sync. "Work like the Mac app."

**Architecture:** The Mac's explorer chat uses `POST /code-assist` (code agent, SSE) with sessions stored as local JSON (`ChatSessionStore`). The iPhone currently chats via `/kb/agent/ask` (meeting agent, ephemeral) — a *different* chat. Phase B adds a **new, second chat surface** (explorer) alongside the existing one:
- New SharedProtocol messages for session CRUD + explorer chat.
- Mac `handleInbound` dispatches them: session ops → `ChatSessionStore` (list/load/save/delete); explorer chat → `api.codeAssistStream(...)` → reply as `Output`, and **persists user+assistant turns** into the Mac session (so it syncs).
- iOS `ExplorerChatView`: session list/picker + transcript (loaded from the Mac) + input/send.

The existing Phase 3/4 chat (`/kb/agent/ask`, images/files) stays as-is — explorer chat is a separate, code-agent, session-synced surface (no images; code-focused).

**Tech Stack:** Swift (macOS 14 / iOS 16), SharedProtocol, `LlmIdeAPIClient.codeAssistStream`, `ChatSessionStore`, XCTest.

**Continues from:** Phase 4 (commit `b11dcc9` on `main`).

## Global Constraints

- Explorer chat is SESSION-SCOPED: every `ExploreChat` carries a `sessionId` (the Mac `ChatSessionStore` UUID, as a `String`). The Mac loads that session, sends history, persists both turns.
- `ChatSessionStore` is Mac-local JSON, **not user-scoped**, keyed by `ChatScope.explorer`. Use the existing static API (`list(for:)/load(id:)/save(_:)/delete(id:)`).
- `codeAssistStream(message:history:attachments:skills:…:onProgress:)` → `CodeAssistResponse` (`reply` + optional `usage`/`pendingTool`). **Map to phone as one `Output{stream: response.reply, done: true}`** (same as Phase 3). `onProgress` labels are logged on the Mac (`append(.info, …)`), NOT sent as reply chunks (they'd pollute the transcript).
- History element = `ChatTurn{role, content}` (existing). The Mac converts `ChatSessionStore`'s `CodeAssistTurn{id, role, content}` ↔ `ChatTurn` (drop `id`).
- New SharedProtocol `type` tags: `explore_list_sessions`, `explore_session_list`, `explore_load_session`, `explore_session_history`, `explore_new_session`, `explore_session_created`, `explore_delete_session`, `explore_chat`. Reuse `Output`/`CommandError` for replies.
- Mac target `@MainActor`; `swift-tools-version: 6.0`, `swiftLanguageModes: [.v5]`. Backend (`extension/`) unchanged. Conventional commits; do not push.

## File Structure

**SharedProtocol** — `MobileProtocol.swift`: add `ExploreSessionSummary`, `ExploreListSessions`, `ExploreSessionList`, `ExploreLoadSession`, `ExploreSessionHistory`, `ExploreNewSession`, `ExploreSessionCreated`, `ExploreDeleteSession`, `ExploreChat`. Tests in `ConnectionMessagesTests.swift`.

**Mac** — `MobileControlManager.swift`: extend `handleInbound` to dispatch the 8 explorer messages; add `handleExploreChat(_:)` (code-assist + persist).

**iOS** — `ControlService.swift`: send/receive the explorer messages + state (`exploreSessions`, `exploreCurrent` history). New `Views/Control/ExplorerChatView.swift`: session list + transcript + input.

---

## Task 1: SharedProtocol — explorer-chat messages (TDD)

**Files:** `MobileProtocol.swift` (append) + `ConnectionMessagesTests.swift` (append).

- [ ] **Step 1: Failing tests** — append round-trip tests for `ExploreChat`, `ExploreSessionList`, `ExploreSessionHistory` (the struct-with-payload ones); assert `type` tags + field round-trips.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — append:

```swift
public struct ExploreSessionSummary: Codable, Equatable {
    public let id: String
    public let title: String
    public let lastUsedAt: Double
    public init(id: String, title: String, lastUsedAt: Double) { self.id = id; self.title = title; self.lastUsedAt = lastUsedAt }
}
public struct ExploreListSessions: Codable, Equatable { public let type = "explore_list_sessions"; public init() {} }
public struct ExploreSessionList: Codable, Equatable {
    public let type = "explore_session_list"
    public let sessions: [ExploreSessionSummary]
    public init(sessions: [ExploreSessionSummary]) { self.sessions = sessions }
}
public struct ExploreLoadSession: Codable, Equatable {
    public let type = "explore_load_session"; public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}
public struct ExploreSessionHistory: Codable, Equatable {
    public let type = "explore_session_history"
    public let sessionId: String; public let title: String; public let history: [ChatTurn]
    public init(sessionId: String, title: String, history: [ChatTurn]) { self.sessionId = sessionId; self.title = title; self.history = history }
}
public struct ExploreNewSession: Codable, Equatable { public let type = "explore_new_session"; public init() {} }
public struct ExploreSessionCreated: Codable, Equatable {
    public let type = "explore_session_created"; public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}
public struct ExploreDeleteSession: Codable, Equatable {
    public let type = "explore_delete_session"; public let sessionId: String
    public init(sessionId: String) { self.sessionId = sessionId }
}
public struct ExploreChat: Codable, Equatable {
    public let type = "explore_chat"
    public let sessionId: String; public let commandId: String; public let text: String; public let history: [ChatTurn]
    public init(sessionId: String, commandId: String, text: String, history: [ChatTurn]) {
        self.sessionId = sessionId; self.commandId = commandId; self.text = text; self.history = history
    }
}
```
(Each with explicit `private enum CodingKeys` per file convention, including `case type`.)

- [ ] **Step 4: Run → PASS** (`cd ios_app/SharedProtocol && swift test`).
- [ ] **Step 5: Commit** `feat(shared-protocol): explorer-chat session + chat messages`.

---

## Task 2: Mac — session-CRUD dispatch (list/load/new/delete)

**Files:** `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (`handleInbound`).

**Interfaces:** Consumes `ChatSessionStore.list(for:)/load(id:)/save(_:)/delete(id:)`, `ChatScope.explorer`, `ChatSession`, `CodeAssistTurn`. Produces: `handleInbound` dispatches the 7 non-chat explorer messages and replies `ExploreSessionList`/`ExploreSessionHistory`/`ExploreSessionCreated`.

- [ ] **Step 1: Read** `ChatSessionStore.swift` + `ChatSession.swift` + `LlmIdeAPIClient+CodeAssist.swift` (`CodeAssistTurn`/`CodeAssistRole`) to confirm exact APIs.
- [ ] **Step 2: Implement dispatch** — in `handleInbound`, before the "Unhandled inbound" fallthrough, add (each `try?`-decodes; first match wins):

```swift
// Explorer session ops
if let _ = try? JSONDecoder().decode(ExploreListSessions.self, from: data) {
    let rows = ChatSessionStore.list(for: .explorer).map { ExploreSessionSummary(id: $0.id.uuidString, title: $0.title, lastUsedAt: $0.lastUsedAt.timeIntervalSince1970) }
    Task { await server?.send(ExploreSessionList(sessions: rows)) }; return
}
if let m = try? JSONDecoder().decode(ExploreLoadSession.self, from: data), let s = ChatSessionStore.load(id: UUID(uuidString: m.sessionId) ?? UUID()) {
    let turns = s.history.map { ChatTurn(role: $0.role.rawValue, content: $0.content) }
    Task { await server?.send(ExploreSessionHistory(sessionId: s.id.uuidString, title: s.title, history: turns)) }; return
}
if let _ = try? JSONDecoder().decode(ExploreNewSession.self, from: data) {
    let s = ChatSession(scope: .explorer, title: "New chat")   // confirm the ChatSession initializer
    ChatSessionStore.save(s)
    Task { await server?.send(ExploreSessionCreated(sessionId: s.id.uuidString)) }; return
}
if let m = try? JSONDecoder().decode(ExploreDeleteSession.self, from: data) {
    if let uid = UUID(uuidString: m.sessionId) { ChatSessionStore.delete(id: uid) }
    return
}
```
(Confirm the `ChatSession(scope:title:)` initializer — if it requires `id`/`createdAt`/`lastUsedAt`/`history`/`storeVersion`, use the memberwise init with `UUID()`, `Date()`, `[]`, `1`. `ChatSessionStore.list` already sorts newest-first.)

- [ ] **Step 3: Verify** — `cd mac && swift build` → BUILD SUCCEEDED.
- [ ] **Step 4: Commit** `feat(mac): dispatch explorer session CRUD over mobile WS`.

---

## Task 3: Mac — ExploreChat → code-assist + persist

**Files:** `MobileControlManager.swift` (add `handleExploreChat`).

**Interfaces:** Consumes `api.codeAssistStream(message:history:attachments:skills:onProgress:)` → `CodeAssistResponse.reply`; `ChatSessionStore.load/save`; `CodeAssistTurn`/`CodeAssistRole`.

- [ ] **Step 1: Add the ExploreChat branch** in `handleInbound` (before the fallthrough):

```swift
if let chat = try? JSONDecoder().decode(ExploreChat.self, from: data) {
    append(.info, "Explore chat in \(chat.sessionId.prefix(8))")
    Task { await handleExploreChat(chat) }; return
}
```

- [ ] **Step 2: Implement `handleExploreChat`**:

```swift
private func handleExploreChat(_ chat: ExploreChat) async {
    guard let api else { await server?.send(CommandError(commandId: chat.commandId, message: "Backend not configured")); return }
    guard let sid = UUID(uuidString: chat.sessionId) else { await server?.send(CommandError(commandId: chat.commandId, message: "Bad session id")); return }
    let history = chat.history.map { LlmIdeAPIClient.CodeAssistTurn(id: UUID(), role: .init(rawValue: $0.role) ?? .user, content: $0.content) }
    do {
        let resp = try await api.codeAssistStream(message: chat.text, history: history, attachments: [], skills: [],
            onProgress: { [weak self] label in self?.append(.info, "code-assist: \(label)") })
        // Persist user + assistant turns into the Mac session (keeps phone & Mac in sync).
        if var session = ChatSessionStore.load(id: sid) {
            session.history.append(LlmIdeAPIClient.CodeAssistTurn(id: UUID(), role: .user, content: chat.text))
            session.history.append(LlmIdeAPIClient.CodeAssistTurn(id: UUID(), role: .assistant, content: resp.reply))
            if session.title == "New chat" { session.title = String(chat.text.prefix(40)) }
            ChatSessionStore.save(session)
        }
        await server?.send(Output(commandId: chat.commandId, payload: OutputPayload(stream: resp.reply, done: true)))
    } catch {
        append(.stderr, "code-assist failed: \(error.localizedDescription)"); lastError = error.localizedDescription
        await server?.send(CommandError(commandId: chat.commandId, message: error.localizedDescription))
    }
}
```
(Confirm `codeAssistStream`'s exact parameter labels + that `CodeAssistTurn` is `LlmIdeAPIClient.CodeAssistTurn`. `attachments: []` / `skills: []` use the real types — `[LlmIdeAPIClient.CodeAttachment]` / `[String]`.)

- [ ] **Step 3: Verify** — `cd mac && swift build` → BUILD SUCCEEDED, 0 warnings.
- [ ] **Step 4: Commit** `feat(mac): explorer chat via code-assist, persisted to ChatSessionStore`.

---

## Task 4: iOS ControlService — explorer session state + send/receive

**Files:** `ios_app/MyApp/Services/ControlService.swift`.

**Interfaces:** Produces: `@Published var exploreSessions: [ExploreSessionSummary]`, `@Published var exploreCurrent: (id: String, title: String, history: [ChatMessage])?`; methods `exploreListSessions()`, `exploreLoadSession(_:)`, `exploreNewSession()`, `exploreDeleteSession(_:)`, `sendExploreChat(_:sessionId:)`. The receive loop handles the 4 new outbound message types.

- [ ] **Step 1: Add state + the 4 request senders** (mirror `sendTextFrame`-based sends used for `Pairing`/`LlmIdeChat`). Each encodes its SharedProtocol struct + `sendTextFrame`.
- [ ] **Step 2: Handle the 4 replies in the receive loop** (`handleMessage`'s `json["type"]` switch):
  - `"explore_session_list"` → `exploreSessions = …` (decode `[ExploreSessionSummary]`).
  - `"explore_session_history"` → `exploreCurrent = (id, title, history → [ChatMessage])`.
  - `"explore_session_created"` → set `exploreCurrent` to the new id (empty history) + re-list.
  - (`"output"`/`"error"` already handled for the chat reply; route `commandId` matches — reuse the existing `exploreCommandIds` set if needed, OR since `ExploreChat` is the only explore chat in flight, a simple flag works.)
- [ ] **Step 3: `sendExploreChat(_:sessionId:)`** — build `ExploreChat(sessionId:commandId:text:history:)` where history = `exploreCurrent.history.suffix(8)` as `[ChatTurn]`; append user + empty-assistant bubbles locally; send; on `"output"` (done) fill the assistant bubble (mirror `sendLlmideChat`'s streaming).
- [ ] **Step 4: Verify** — `cd ios_app && xcodebuild … iOS Simulator build` → `** BUILD SUCCEEDED **`.
- [ ] **Step 5: Commit** `feat(ios): ControlService explorer-chat session state + send`.

---

## Task 5: iOS ExplorerChatView

**Files:** new `ios_app/MyApp/Views/Control/ExplorerChatView.swift` (add to the Xcode target the same way Phase 1 Task 6 added a file — confirm the target membership mechanism; the project uses classic groups so the file may need adding to the target via Xcode, OR it auto-includes if under the synced group). Wire it into the app's navigation (e.g. a tab/button from `ContentView`/`RemoteDesktopView`).

- [ ] **Step 1: Build the view** — a session list (from `controlService.exploreSessions`, tap → `exploreLoadSession`), a "New chat" button (`exploreNewSession`), the current transcript (`exploreCurrent.history`), and an input bar (text + send → `sendExploreChat`). On appear → `exploreListSessions()`. Mirror the styling of `LlmIdeControlView` (reuse `DesignSystem`).
- [ ] **Step 2: Wire navigation** — add an entry point (e.g. a sheet/tab from the existing UI) to open `ExplorerChatView`. Keep it minimal.
- [ ] **Step 3: Verify** — iOS sim build SUCCEEDED.
- [ ] **Step 4: Commit** `feat(ios): native ExplorerChatView (session list + transcript)`.

---

## Task 6: Verify + docs

- [ ] **Step 1: Full gate** — SharedProtocol `swift test`, `mac swift build`, iOS `xcodebuild` — all green.
- [ ] **Step 2: Manual check** (documented; paired phone + backend login): phone → Explorer Chat → session list matches Mac's explorer sessions; tap a session → its history loads; send a message → code-agent reply appears AND the turn shows on the Mac's explorer chat (sync verified); "New chat" creates one visible on both.
- [ ] **Step 3: Docs** — note the explorer-chat surface in `docs/mobile/quick-start.md`.
- [ ] **Step 4: Commit** `docs: note Phase B native explorer chat`.

---

## Phase B Done — Definition of Done

- [ ] SharedProtocol: 9 explorer message types + tests.
- [ ] Mac: session CRUD dispatch + `ExploreChat`→`codeAssistStream`→`Output`, turns persisted to `ChatSessionStore` (Mac↔phone sync). `swift build` green.
- [ ] iOS: `ExplorerChatView` (session list + transcript + send) + ControlService state/send. iOS build green.
- [ ] Backend unchanged. Phone and Mac show the same explorer sessions/chats.

## Follow-on

- Phase C: native iOS **auto-task** view (Mac exposes auto-task list/state/actions). Then polish (color palette, port-busy guard). Explorer-chat attachments (code files) + new-session/delete from the phone can be refined later.
