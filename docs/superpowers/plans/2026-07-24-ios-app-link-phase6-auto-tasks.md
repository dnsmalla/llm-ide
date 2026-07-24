# iOS↔Mac Native Link — Phase C (6): Native Auto-Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A native iOS "Auto Tasks" view that lists the Mac's 8 auto-task jobs + their status/enable flags, shows run progress + action history, and lets the phone **trigger a run (global or single), stop, and toggle enables** — driving the Mac's `AutoCodeUpdateService`. "Work like the Mac app's Auto Tasks tab."

**Architecture:** AutoTask state is **Mac-local** (UserDefaults `AutoTaskSettings` + JSON `ProcessedActionsRegistry` + in-memory `TaskLogStore` + the `AutoCodeUpdateService` orchestrator) — there is **no backend endpoint** for it. So Phase C mirrors Phase B: new SharedProtocol messages (request/reply), Mac `handleInbound` reads the `@MainActor` Mac state and replies, and triggers `runNow`/`runSingle`/`cancel` + sets `AutoTaskSettings`. `AutoCodeUpdateService` + `AutoTaskSettings` are wired into `MobileControlManager` (settable properties, like Phase B's `api`). Polling (request on view-appear / focus) for live status — no server push (matches explorer-chat). Backend unchanged.

**Tech Stack:** Swift (macOS 14 / iOS 16), SharedProtocol, `AutoCodeUpdateService`/`AutoTaskSettings`/`ProcessedActionsRegistry`, XCTest.

**Continues from:** Phase B (commit `edc0be6` on `main`).

## Global Constraints

- The 8 `AutoTask` cases (`reviewCode`/`reviewDoc`/`reviewConflicts`/`regression`/`generateKnowledge`/`generateDoc`/`updateIssues`/`updatePlanStatus`) are identified on the wire by their `String` `rawValue` (stable).
- Dispatch via the **envelope `{type}` switch** in `handleInbound` (Phase B Task-2 fix) — add `auto_task_*` cases. (SharedProtocol structs don't validate `type` on decode; the switch does.)
- All Mac reads of `AutoCodeUpdateService`/`AutoTaskSettings`/`ProcessedActionsRegistry` happen on `@MainActor` inside `handleInbound` (these types aren't Sendable), then encode into wire structs.
- New `type` tags: `auto_task_list`, `auto_task_state`, `auto_task_run`, `auto_task_stop`, `auto_task_toggle`, `auto_task_ack`, `auto_task_history`, `auto_task_history_reply`. Reuse `CommandError` for failures.
- Running a task operates on the Mac's **active project** (the orchestrator resolves backend+repo); the phone just triggers — it doesn't pick a project.
- Mac target `@MainActor`; `swift-tools-version: 6.0`, `swiftLanguageModes: [.v5]`. Backend unchanged. Conventional commits; do not push.

## File Structure

**SharedProtocol** — `MobileProtocol.swift`: add `AutoTaskInfo`, `AutoTaskList`, `AutoTaskState`, `AutoTaskRun`, `AutoTaskStop`, `AutoTaskToggle`, `AutoTaskAck`, `AutoTaskHistoryList`, `AutoTaskHistoryReply`, `AutoTaskHistoryEntry`. Tests in `ConnectionMessagesTests.swift`.

**Mac** — `MobileControlManager.swift`: add settable `autoCode: AutoCodeUpdateService?` + `autoTaskSettings: AutoTaskSettings?`; extend `handleInbound` with the `auto_task_*` cases; wire from the app.

**iOS** — `ControlService.swift`: auto-task state + senders; new `Views/Control/AutoTaskView.swift`.

---

## Task 1: SharedProtocol — auto-task messages (TDD)

**Files:** `MobileProtocol.swift` (append) + `ConnectionMessagesTests.swift` (append).

- [ ] **Step 1: Failing tests** — round-trip for `AutoTaskState` (with a couple `AutoTaskInfo`) + `AutoTaskRun` + `AutoTaskHistoryReply`; assert `type` tags + fields.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — append (each `public Codable Equatable` + explicit `CodingKeys` incl `case type`):

```swift
public struct AutoTaskInfo: Codable, Equatable {
    public let id: String        // AutoTask.rawValue
    public let label: String
    public let enabled: Bool
    public let lastError: String?
    public init(id: String, label: String, enabled: Bool, lastError: String?) { self.id = id; self.label = label; self.enabled = enabled; self.lastError = lastError }
}
public struct AutoTaskList: Codable, Equatable { public let type = "auto_task_list"; public init() {} }
public struct AutoTaskState: Codable, Equatable {
    public let type = "auto_task_state"
    public let masterEnabled: Bool
    public let isRunning: Bool
    public let currentTask: String?
    public let statusMessage: String?
    public let lastRunDate: Double?
    public let createdCount: Int
    public let implementedCount: Int
    public let failedCount: Int
    public let tasks: [AutoTaskInfo]
}
public struct AutoTaskRun: Codable, Equatable { public let type = "auto_task_run"; public let task: String?; public init(task: String?) { self.task = task } }
public struct AutoTaskStop: Codable, Equatable { public let type = "auto_task_stop"; public init() {} }
public struct AutoTaskToggle: Codable, Equatable {
    public let type = "auto_task_toggle"
    public let task: String?      // nil = master enable
    public let enabled: Bool
    public init(task: String?, enabled: Bool) { self.task = task; self.enabled = enabled }
}
public struct AutoTaskAck: Codable, Equatable { public let type = "auto_task_ack"; public let ok: Bool; public let message: String? }
public struct AutoTaskHistoryList: Codable, Equatable { public let type = "auto_task_history"; public init() {} }
public struct AutoTaskHistoryEntry: Codable, Equatable {
    public let actionText: String; public let status: String; public let lastUpdated: Double
}
public struct AutoTaskHistoryReply: Codable, Equatable {
    public let type = "auto_task_history_reply"; public let entries: [AutoTaskHistoryEntry]
}
```
(Add public inits where the brief omits them — needed since the Mac constructs these. `AutoTaskState`/`AutoTaskAck`/`AutoTaskHistoryReply` need explicit inits.)

- [ ] **Step 4: Run → PASS** (`swift test`).
- [ ] **Step 5: Commit** `feat(shared-protocol): auto-task messages`.

---

## Task 2: Mac — list/state/toggle + wire AutoCodeUpdateService/AutoTaskSettings

**Files:** `MobileControlManager.swift`; wire from the app (`LlmIdeMacApp.swift` or `AppShell` — wherever `AutoCodeUpdateService`/`AutoTaskSettings` are owned).

**Interfaces:** Consumes `AutoCodeUpdateService` (`@Published isRunning`/`currentTask`/`statusMessage`/`lastRunDate`/`createdCount`/`implementedCount`/`failedCount`/`taskErrors`) + `AutoTaskSettings` (`enabled`, per-task `runReviewCode`…, and the `AutoTask` enum's `label`). Produces: settable `autoCode`/`autoTaskSettings` on the manager; `handleInbound` cases for `auto_task_list`/`auto_task_toggle`.

- [ ] **Step 1: Read** `AutoCodeUpdateService.swift` + `AutoTaskSettings.swift` + `AutoTask` enum (`AutoCodeView.swift:490`) + where they're owned (AppShell/LlmIdeMacApp). Confirm `AutoTask.allCases`, `.label`, `.rawValue`, the per-task enable flag names, and `taskErrors` keying.
- [ ] **Step 2: Add settable properties** to `MobileControlManager`:
```swift
var autoCode: AutoCodeUpdateService?
var autoTaskSettings: AutoTaskSettings?
```
- [ ] **Step 3: `handleInbound` cases** (in the envelope switch):
```swift
case "auto_task_list":
    guard let ac = autoCode, let s = autoTaskSettings else { Task { await server?.send(CommandError(commandId: "auto", message: "Auto-tasks not configured")) }; return }
    let infos = AutoTask.allCases.map { t in
        AutoTaskInfo(id: t.rawValue, label: t.label, enabled: s.isEnabled(task: t), lastError: ac.taskErrors[t.rawValue])
    }
    let state = AutoTaskState(masterEnabled: s.enabled, isRunning: ac.isRunning, currentTask: ac.currentTask?.rawValue,
                              statusMessage: ac.statusMessage, lastRunDate: ac.lastRunDate?.timeIntervalSince1970,
                              createdCount: ac.createdCount, implementedCount: ac.implementedCount, failedCount: ac.failedCount, tasks: infos)
    Task { await server?.send(state) }
case "auto_task_toggle":
    if let m = try? JSONDecoder().decode(AutoTaskToggle.self, from: data) {
        if let task = m.task, let t = AutoTask(rawValue: task) { autoTaskSettings?.setEnabled(m.enabled, task: t) }
        else { autoTaskSettings?.enabled = m.enabled }
        Task { await server?.send(AutoTaskAck(ok: true, message: nil)) }
    }
```
(Confirm `AutoTaskSettings.isEnabled(task:)` / `setEnabled(_:task:)` exist — if the per-task flags are individual `@Published` properties, add small helpers or switch on the task. Use the REAL API.)

- [ ] **Step 4: Wire** — where `MobileControlManager` + `AutoCodeUpdateService`/`AutoTaskSettings` are both constructed (likely `LlmIdeMacApp.init` or `AppShell`), set `mobileControl.autoCode = …` + `mobileControl.autoTaskSettings = …` (mirror Phase B's `mobileControl.api = client`).
- [ ] **Step 5: Verify** — `cd mac && swift build` → BUILD SUCCEEDED.
- [ ] **Step 6: Commit** `feat(mac): auto-task list/state + toggle over mobile WS`.

---

## Task 3: Mac — run/stop/history

**Files:** `MobileControlManager.swift`.

**Interfaces:** Consumes `AutoCodeUpdateService.runNow()`/`runSingle(_:)`/`cancel()`/`allEntries` (`[ProcessedActionsRegistry.RegistryEntry]`).

- [ ] **Step 1: `handleInbound` cases**:
```swift
case "auto_task_run":
    if let m = try? JSONDecoder().decode(AutoTaskRun.self, from: data) {
        if let raw = m.task, let t = AutoTask(rawValue: raw) { Task { await autoCode?.runSingle(t) } }
        else { Task { await autoCode?.runNow() } }
        Task { await server?.send(AutoTaskAck(ok: true, message: nil)) }
    }
case "auto_task_stop":
    autoCode?.cancel()
    Task { await server?.send(AutoTaskAck(ok: true, message: nil)) }
case "auto_task_history":
    let entries = (autoCode?.allEntries ?? []).map { AutoTaskHistoryEntry(actionText: $0.actionText, status: $0.status.rawValue, lastUpdated: $0.lastUpdated.timeIntervalSince1970) }
    Task { await server?.send(AutoTaskHistoryReply(entries: entries)) }
```
(Confirm `runSingle`/`runNow` signatures — `runSingle(_:)` may be async or sync on @MainActor; `allEntries` returns the registry entries; `EntryStatus.rawValue`. Use the REAL APIs. `cancel()` may need `Task { await autoCode?.cancel() }` if async.)

- [ ] **Step 2: Verify** — `cd mac && swift build` → BUILD SUCCEEDED.
- [ ] **Step 3: Commit** `feat(mac): auto-task run/stop/history over mobile WS`.

---

## Task 4: iOS ControlService — auto-task state + senders

**Files:** `ios_app/MyApp/Services/ControlService.swift`.

- [ ] **Step 1: State** — `@Published var autoTaskState: AutoTaskState?`, `@Published var autoTaskHistory: [AutoTaskHistoryEntry] = []`.
- [ ] **Step 2: Senders** — `autoTaskList()` (→ `AutoTaskList`), `autoTaskRun(_ task: String?)` (→ `AutoTaskRun`), `autoTaskStop()` (→ `AutoTaskStop`), `autoTaskToggle(task: String?, enabled: Bool)` (→ `AutoTaskToggle`), `autoTaskHistory()` (→ `AutoTaskHistoryList`). Each encodes its SharedProtocol message + `sendTextFrame`, guarded on connected.
- [ ] **Step 3: Receive cases** in `handleMessage`: `auto_task_state` → `autoTaskState = …`; `auto_task_history_reply` → `autoTaskHistory = …`; `auto_task_ack` → optional toast/log (ignore `ok` quietly or surface `message`).
- [ ] **Step 4: Verify** — iOS sim build SUCCEEDED.
- [ ] **Step 5: Commit** `feat(ios): ControlService auto-task state + send`.

---

## Task 5: iOS AutoTaskView

**Files:** new `ios_app/MyApp/Views/Control/AutoTaskView.swift` (add to the `MyApp` target via pbxproj — classic groups, like Phase B Task 5); entry point (e.g. an "Auto" toolbar button in `RemoteDesktopView` peer to "Explore"/"Chat").

- [ ] **Step 1: Build the view** — header (master enable toggle + isRunning/status + Run Now / Stop); the 8 task rows (label + enable toggle + Run-single ▶) from `autoTaskState.tasks`; a History section (`autoTaskHistory`); counts (created/implemented/failed). `.onAppear { autoTaskList(); autoTaskHistory() }`; refresh on focus. Reuse `DesignSystem` (mirror `ExplorerChatView`/`LlmIdeControlView`).
- [ ] **Step 2: Entry point** — toolbar button → sheet (peer to the existing "Explore"/"Chat" buttons).
- [ ] **Step 3: Target membership** — add the file to pbxproj (4 places); the compiling build is the proof.
- [ ] **Step 4: Verify** — iOS sim build SUCCEEDED.
- [ ] **Step 5: Commit** `feat(ios): native AutoTaskView`.

---

## Task 6: Verify + docs

- [ ] **Step 1: Full gate** — SharedProtocol `swift test`, `mac swift build`, iOS `xcodebuild` — green.
- [ ] **Step 2: Manual check** (documented; paired phone + an active Mac project + backend): phone → Auto Tasks → list matches Mac (8 tasks, enables, status); Run Now → Mac runs (status + counts update on refresh); Run single; Stop; toggle enable reflects on the Mac; history matches.
- [ ] **Step 3: Docs** — note the Auto Tasks surface in `docs/mobile/quick-start.md`.
- [ ] **Step 4: Commit** `docs: note Phase C native auto-tasks`.

---

## Phase C Done — Definition of Done

- [ ] SharedProtocol: auto-task messages + tests.
- [ ] Mac: list/state/toggle + run/stop/history dispatch; `AutoCodeUpdateService`/`AutoTaskSettings` wired into the manager. `swift build` green.
- [ ] iOS: `AutoTaskView` (list + toggles + run/stop + history) + ControlService state. iOS build green.
- [ ] Backend unchanged. Phone drives the Mac's auto-tasks.

## Follow-on (polish phase)
llm-ide color palette; port-busy guard; per-task **log viewer** + **template editor** on the phone; stale-sessionId error path (Phase B); live status push (vs polling); scanned-PDF OCR (Phase 4).
