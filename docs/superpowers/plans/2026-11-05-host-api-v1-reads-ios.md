> **Status: implemented and verified 2026-11-05** (`cee52c7a`..`e0e6ac75`); SharedProtocol 95/95 tests and unsigned iOS build pass. The manual F19-F28 device checks remain a user-run gate.

# Host API v1 Reads on iOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Host API v1 connection whose host granted `read`, the iPhone app shows the user's chats on the host (paged), one chat's history read-only, and the usage summary, and it changes nothing for v2 (Mac) connections.

**Architecture:** All logic lives in `ios_app/SharedProtocol` where swift-testing runs in CI (`make test-shared-protocol`): a pure gate (`HostApiReadGate`), a pure `usage.get` → `UsageState` mapper (`HostApiReadMapping`), and a Swift port of the web read controller (`HostApiReadController`, same paging, caps, stale-reply ticket and in-flight guard as `web/src/read/controller.ts`). The app wires the controller into `ConnectionService` (published `readState`), sends `usage.get` from the existing `UsageStore` and adds one thin view file (`ReadChatsView.swift`: chat list + usage strip + read-only history) shown as a "History" tab only when the gate is on.

**Tech Stack:** Swift 5.9 package (`swift-testing`, `import Testing`), SwiftUI iOS 16+, Xcode project `ios_app/MyApp.xcodeproj` (explicit file references, objectVersion 63), generated Host API v1 types in `HostApiCommands.swift` / `HostApiPayloads.swift`.

**Spec:** `docs/superpowers/plans/2026-11-05-host-api-v1-read-commands.md` (Scope "Not in this plan" → iOS follow-up; Decisions 1-4), `docs/superpowers/specs/2026-11-03-host-api-design.md`, `schema/host-api/v1/commands.json` (`chat.sessions`, `chat.history`, `usage.get`), reference behaviour `web/src/read/controller.ts` + `web/src/screens/ReadPanel.tsx`.

## Global Constraints

- **Read-only.** Nothing added here sends `chat.send`, `chat.cancel`, `chat.history.clear` or any write. Opening a chat never changes which chat the Chat tab sends to (prior plan Decision 2: "Open, never switch").
- **Shown only when connected over v1 AND the host granted `read`:** `hostApiVersion == 1 && macCapabilities?.contains("read") == true`. Not optimistic: a nil capability set is OFF (unlike `ConnectionService.supports`, which is optimistic for v2).
- **The read controller sends only through the v1 client** (`ConnectionService.v1Client`), never through `v2Host`, so a v2 Mac can never receive these commands.
- **Strict capability enum stays** (prior plan Decision 4). No relaxing of generated types; generated files (`HostApi{Commands,Payloads,Schemas}.swift`) are never hand-edited.
- **Caps (copied from the web client):** sessions page 50, `MAX_SESSIONS = 500`; history page 100, `MAX_OPEN_MESSAGES = 2000`; error text clamped to 500 characters.
- **Units:** `chat.sessions` `updatedAt` and `usage.get` `resetAt` are milliseconds since 1970 (`extension/routes/host-api/reads.mjs:22,68`); `UsageMeter.resetsAt` is seconds.
- **No persistence of read data:** memory only, cleared on disconnect, on a capability change that drops `read`, and on a new device.
- **Mac frozen:** no change under `mac/`. The Mac links SharedProtocol, so `cd mac && swift build` must still pass (new SharedProtocol types are additive and unused there).
- **No new MyApp test target** (there is none today); every branch with logic is in SharedProtocol and tested there. SwiftUI views stay thin.
- **Accessibility:** use `DesignSystem.Typography.*` (all are text styles, so Dynamic Type scales); every row is one VoiceOver element with a spoken label; no fixed-height text containers.
- Conventional Commits, one concern per commit, commit on `main` (user rule: no branches). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions for the user (secure defaults, already applied in this plan)

1. **Where the chat list lives:** a separate "History" tab, present only when v1 + `read`. Recommended: tab (mirrors the existing Project/Activity tab gating, and keeps the live Chat tab untouched). Alternative: a toolbar button inside the Chat tab.
2. **The phone chat row is not openable** in History (it is the live Chat tab); it shows "Live chat · on the Chat tab". Recommended: yes (one place to see the live chat; no second, stale copy).
3. **Assistant replies render with the existing `ChatBubble` markdown**, exactly as the live Chat tab renders the same host text. Recommended: yes. Alternative: plain `Text(verbatim:)` for history.
4. **`read` revoked mid-session clears what is on screen** (list, open chat, v1 usage) at once. Recommended: yes.
5. **v1 usage has no permission mode:** the permission row and the Context bar chip stay hidden on v1; never guessed. Recommended: yes.
6. **Refresh points:** on connect, on History tab first appear, pull-to-refresh, and on a `rev` gap (`resync`). No polling. Recommended: yes.

## File Structure

| File | Responsibility |
|---|---|
| `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiReads.swift` (create) | `HostApiReadGate`, `HostApiReadMapping.usageState`, `HostApiReadState`, `HostApiOpenChat`, `HostApiReadController` |
| `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift` (create) | gate, mapper and controller tests with a fake `HostConnection` |
| `ios_app/MyApp/Services/ConnectionService.swift` (modify) | `readState`, `reads`, `servesV1Read`, reset on disconnect / revoke, resync refresh |
| `ios_app/MyApp/Services/UsageStore.swift` (modify) | `usage.get` path on v1 |
| `ios_app/MyApp/Views/Control/UsageView.swift` (modify) | hide the permission section when the mode is unknown (v1) |
| `ios_app/MyApp/Views/Settings/SettingsView.swift` (modify) | Usage link also on v1 + `read` |
| `ios_app/MyApp/Views/RootTabView.swift` (modify) | History tab, v1 refresh, tab fallback, usage reset rule |
| `ios_app/MyApp/Views/Control/ReadChatsView.swift` (create) | `ReadChatsView` (list + usage strip) and `ReadChatHistoryView` |
| `ios_app/MyApp.xcodeproj/project.pbxproj` (modify) | four entries for `ReadChatsView.swift` |
| `docs/mobile/verification.md` (modify) | new F-rows F19-F28 |

---

### Task 1: Read gate and usage mapper (SharedProtocol)

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiReads.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift`

**Interfaces:**
- Consumes: generated `HostApiCommand.chatSessions.capability` (`"read"`), `HostApiUsageGetResult` / `HostApiUsageGetResultProvidersItem` / `HostApiUsageGetResultProvidersItemModelsItem` (`HostApiPayloads.swift:310-360`), `UsageState` / `UsageMeter` (`UsageMessages.swift`).
- Produces:
  - `public enum HostApiReadGate { public static func isOn(apiVersion: Int, capabilities: Set<String>?) -> Bool }`
  - `public enum HostApiReadMapping { public static func usageState(_ r: HostApiUsageGetResult) -> UsageState }`

- [x] **Step 1: Write the failing tests**

Create `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("HostApiReadGate + HostApiReadMapping")
struct HostApiReadMappingTests {
    @Test("the gate is on only for v1 with read granted; never optimistic, never on v2")
    func gate() {
        #expect(HostApiReadGate.isOn(apiVersion: 1, capabilities: ["host", "chat", "read"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 1, capabilities: ["host", "chat"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 1, capabilities: nil))
        #expect(!HostApiReadGate.isOn(apiVersion: 2, capabilities: ["read", "usage"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 2, capabilities: nil))
    }

    typealias Model = HostApiUsageGetResultProvidersItemModelsItem

    @Test("one provider: label wins, capped and uncapped detail, ms → s reset, no permission mode")
    func oneProvider() {
        let r = HostApiUsageGetResult(providers: [.init(activeModel: "claude-sonnet", models: [
            Model(label: "Sonnet", limit: 100, model: "claude-sonnet", pct: 42, resetAt: 1_700_000_000_000,
                  state: "ok", unit: "runs", used: 42, window: "daily"),
            Model(limit: 0, model: "claude-haiku", resetAt: 0, state: "ok", unit: "tokens", used: 900, window: "monthly"),
        ], provider: "claude", status: "ok")])
        let s = HostApiReadMapping.usageState(r)
        #expect(s.provider == "claude")
        #expect(s.status == "ok")
        #expect(s.activeModel == "claude-sonnet")
        #expect(s.permissionMode == "")
        #expect(s.subscription.isEmpty && s.subscriptionNote == nil && s.error == nil && s.statusReason == nil)
        #expect(s.models == [
            UsageMeter(name: "Sonnet", pct: 42, state: "ok", detail: "42 of 100 runs · Daily", resetsAt: 1_700_000_000),
            UsageMeter(name: "claude-haiku", pct: nil, state: "ok", detail: "900 tokens · Monthly, no cap", resetsAt: nil),
        ])
    }

    @Test("several providers: names are prefixed, the first non-ok status wins, empty stays empty")
    func severalProviders() {
        let m = Model(limit: 10, model: "m", resetAt: 0, state: "exhausted", unit: "runs", used: 10, window: "daily")
        let r = HostApiUsageGetResult(providers: [
            .init(models: [m], provider: "claude", status: "ok"),
            .init(models: [m], provider: "openai", status: "paused"),
        ])
        let s = HostApiReadMapping.usageState(r)
        #expect(s.provider == "claude, openai")
        #expect(s.status == "paused")
        #expect(s.models.map(\.name) == ["claude · m", "openai · m"])
        let empty = HostApiReadMapping.usageState(HostApiUsageGetResult(providers: []))
        #expect(empty.provider == nil && empty.status == nil && empty.models.isEmpty)
    }
}
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/ios_app/SharedProtocol && swift test --filter HostApiReadMappingTests`
Expected: FAIL to compile with "cannot find 'HostApiReadGate' in scope". (If `swift build` reports "Invalid manifest" or "Operation not permitted", that is the command sandbox, not the code: rerun unsandboxed.)

- [x] **Step 3: Write the minimal implementation**

Create `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiReads.swift`:

```swift
import Foundation

// MARK: - Host API v1 `read` (chat.sessions, chat.history, usage.get) on the phone
//
// Read-only. Nothing here sends a write, and opening a chat never changes where `chat.send` goes.
// Behaviour mirrors web/src/read/controller.ts: same pages, caps, stale-reply ticket and in-flight guard.

/// Whether the read screens exist at all. Not optimistic: no capability list means off, and v2 is always off.
public enum HostApiReadGate {
    public static func isOn(apiVersion: Int, capabilities: Set<String>?) -> Bool {
        apiVersion == 1 && capabilities?.contains(HostApiCommand.chatSessions.capability) == true
    }
}

public enum HostApiReadMapping {
    /// `usage.get` → the `UsageState` the existing Usage screen renders. v1 carries no permission mode, no
    /// subscription windows and no limit configuration, so those stay empty rather than guessed.
    public static func usageState(_ r: HostApiUsageGetResult) -> UsageState {
        let prefix = r.providers.count > 1
        let models = r.providers.flatMap { p in
            p.models.map { m -> UsageMeter in
                let name = m.label ?? m.model
                let window = m.window.capitalized
                let detail = m.limit > 0 ? "\(m.used) of \(m.limit) \(m.unit) · \(window)"
                                         : "\(m.used) \(m.unit) · \(window), no cap"
                return UsageMeter(name: prefix ? "\(p.provider) · \(name)" : name, pct: m.pct.map { Double($0) },
                                  state: m.state, detail: detail,
                                  resetsAt: m.resetAt > 0 ? Double(m.resetAt) / 1000 : nil)
            }
        }
        return UsageState(
            provider: r.providers.isEmpty ? nil : r.providers.map(\.provider).joined(separator: ", "),
            status: r.providers.first(where: { $0.status != "ok" })?.status ?? r.providers.first?.status,
            statusReason: nil, activeModel: r.providers.first?.activeModel, models: models,
            subscription: [], subscriptionNote: nil, permissionMode: "", error: nil)
    }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/dinsmallade/llm-ide/ios_app/SharedProtocol && swift test --filter HostApiReadMappingTests`
Expected: PASS (3 tests).

- [x] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiReads.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift
git commit -m "feat(ios): Host API v1 read gate and usage.get mapper in SharedProtocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read controller (SharedProtocol)

**Files:**
- Modify: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiReads.swift` (append)
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift` (append)

**Interfaces:**
- Consumes: `HostApiReadGate.isOn` (Task 1); `HostConnection.send(_:_:id:as:)` (`HostConnection.swift:45-50`); generated `HostApiChatSessionsRequest/Result`, `HostApiChatSessionsResultSessionsItem`, `HostApiChatHistoryRequest/Result`, `HostApiChatHistoryResultMessagesItem`; `HostApiRejection.message`.
- Produces:
  - `public struct HostApiOpenChat: Equatable, Sendable { id: String; title: String; messages: [HostApiChatHistoryResultMessagesItem]; nextBeforeSeq: Int? }`
  - `public struct HostApiReadState: Equatable, Sendable { sessions: [HostApiChatSessionsResultSessionsItem]; nextOffset: Int?; open: HostApiOpenChat?; loading: Bool; error: String? }` with `public init()`
  - `@MainActor public final class HostApiReadController` with `init(host: @escaping () -> HostConnection?)`, `var state: HostApiReadState { get }`, `var onChange: ((HostApiReadState) -> Void)?`, `func refresh() async`, `func moreSessions() async`, `func open(id: String, title: String) async`, `func older() async`, `func close()`, `func reset()`, statics `maxSessions = 500`, `maxOpenMessages = 2000`, `sessionsPage = 50`, `historyPage = 100`.

- [x] **Step 1: Write the failing tests**

Append to `HostApiReadsTests.swift`:

```swift
/// A host whose replies the test releases one by one, so ordering races can be scripted.
@MainActor
final class FakeReadHost: HostConnection {
    var apiVersion = 1
    var state: HostConnectionState = .connected
    var capabilities: Set<String> = ["host", "chat", "read"]
    var onEvent: ((HostEvent) -> Void)?
    private(set) var calls: [(command: HostApiCommand, payload: Data)] = []
    private var waiting: [CheckedContinuation<Data, Error>] = []

    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        calls.append((command, payload))
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }
    func close() {}
    func answer<R: Encodable>(_ i: Int, _ result: R) { waiting[i].resume(returning: try! JSONEncoder().encode(result)) }
    func fail(_ i: Int, _ message: String) {
        waiting[i].resume(throwing: HostApiRejection(replyTo: nil, code: "not_found", message: message))
    }
    func waitForCalls(_ n: Int) async { for _ in 0..<1000 where calls.count < n { await Task.yield() } }
    func payload<P: Decodable>(_ i: Int, as: P.Type) -> P { try! JSONDecoder().decode(P.self, from: calls[i].payload) }
}

@MainActor
@Suite("HostApiReadController")
struct HostApiReadControllerTests {
    let host = FakeReadHost()
    func controller() -> HostApiReadController { HostApiReadController(host: { [host] in host }) }
    func sessions(_ r: Range<Int>) -> [HostApiChatSessionsResultSessionsItem] {
        r.map { .init(id: "s\($0)", title: "Chat \($0)", updatedAt: $0) }
    }
    func lines(_ r: ClosedRange<Int>) -> [HostApiChatHistoryResultMessagesItem] {
        r.map { .init(content: "m\($0)", role: $0 % 2 == 0 ? "assistant" : "user", seq: $0) }
    }
    func loaded(_ c: HostApiReadController, first: Range<Int>, next: Int?) async {
        let t = Task { await c.refresh() }
        await host.waitForCalls(host.calls.count + 1)
        host.answer(host.calls.count - 1, HostApiChatSessionsResult(nextOffset: next, sessions: sessions(first)))
        await t.value
    }

    @Test("sends nothing without a host, on v2, or without read")
    func gated() async {
        let none = HostApiReadController(host: { nil })
        await none.refresh()
        host.apiVersion = 2
        await controller().refresh()
        host.apiVersion = 1; host.capabilities = ["host", "chat"]
        let c = controller()
        await c.refresh(); await c.open(id: "a", title: "A")
        #expect(host.calls.isEmpty)
        #expect(c.state == HostApiReadState())
    }

    @Test("refresh asks for the first 50 and keeps nextOffset")
    func refresh() async {
        let c = controller()
        var seen: [HostApiReadState] = []
        c.onChange = { seen.append($0) }
        await loaded(c, first: 0..<50, next: 50)
        #expect(host.calls[0].command == .chatSessions)
        #expect(host.payload(0, as: HostApiChatSessionsRequest.self) == .init(limit: 50, offset: nil))
        #expect(c.state.sessions.count == 50 && c.state.nextOffset == 50 && !c.state.loading)
        #expect(seen.first?.loading == true && seen.last == c.state)
    }

    @Test("more: one page at a time, de-duplicated, stops at 500")
    func more() async {
        let c = controller()
        await loaded(c, first: 0..<480, next: 480)
        let a = Task { await c.moreSessions() }
        await host.waitForCalls(2)
        await c.moreSessions()   // a second tap while the first is in flight sends nothing
        #expect(host.calls.count == 2)
        #expect(host.payload(1, as: HostApiChatSessionsRequest.self) == .init(limit: 50, offset: 480))
        host.answer(1, HostApiChatSessionsResult(nextOffset: 530, sessions: sessions(0..<1) + sessions(480..<530)))
        await a.value
        #expect(c.state.sessions.count == HostApiReadController.maxSessions)
        #expect(c.state.sessions.map(\.id).filter { $0 == "s0" }.count == 1)
        #expect(c.state.nextOffset == nil)
    }

    @Test("open: a reply for an earlier open is dropped, and so is its error")
    func staleOpen() async {
        let c = controller()
        let a = Task { await c.open(id: "a", title: "A") }
        await host.waitForCalls(1)
        let b = Task { await c.open(id: "b", title: "B") }
        await host.waitForCalls(2)
        host.answer(1, HostApiChatHistoryResult(messages: lines(1...3)))
        await b.value
        host.fail(0, "That chat is gone.")
        await a.value
        #expect(c.state.open?.id == "b" && c.state.open?.title == "B")
        #expect(c.state.open?.messages.count == 3 && c.state.open?.nextBeforeSeq == nil)
        #expect(c.state.error == nil)
        #expect(host.payload(1, as: HostApiChatHistoryRequest.self) == .init(beforeSeq: nil, limit: 100, sessionId: "b"))
    }

    @Test("older prepends, keeps the newest 2000, and is dropped after close")
    func older() async {
        let c = controller()
        let o = Task { await c.open(id: "a", title: "A") }
        await host.waitForCalls(1)
        host.answer(0, HostApiChatHistoryResult(messages: lines(101...2090), nextBeforeSeq: 101))
        await o.value
        let p = Task { await c.older() }
        await host.waitForCalls(2)
        #expect(host.payload(1, as: HostApiChatHistoryRequest.self) == .init(beforeSeq: 101, limit: 100, sessionId: "a"))
        host.answer(1, HostApiChatHistoryResult(messages: lines(1...100)))
        await p.value
        #expect(c.state.open?.messages.count == HostApiReadController.maxOpenMessages)
        #expect(c.state.open?.messages.first?.seq == 91 && c.state.open?.messages.last?.seq == 2090)
        #expect(c.state.open?.nextBeforeSeq == nil)

        let q = Task { await c.open(id: "a", title: "A") }
        await host.waitForCalls(3)
        host.answer(2, HostApiChatHistoryResult(messages: lines(5...6), nextBeforeSeq: 5))
        await q.value
        let r = Task { await c.older() }
        await host.waitForCalls(4)
        c.close()
        host.answer(3, HostApiChatHistoryResult(messages: lines(1...4)))
        await r.value
        #expect(c.state.open == nil && c.state.error == nil)
    }

    @Test("a host error is shown, clamped; reset drops an in-flight reply")
    func errorsAndReset() async {
        let c = controller()
        let t = Task { await c.refresh() }
        await host.waitForCalls(1)
        host.fail(0, String(repeating: "x", count: 900))
        await t.value
        #expect(c.state.error?.count == 500 && !c.state.loading)

        let u = Task { await c.refresh() }
        await host.waitForCalls(2)
        c.reset()
        host.answer(1, HostApiChatSessionsResult(sessions: sessions(0..<3)))
        await u.value
        #expect(c.state == HostApiReadState())
    }
}
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/ios_app/SharedProtocol && swift test --filter HostApiReadControllerTests`
Expected: FAIL to compile with "cannot find 'HostApiReadController' in scope".

- [x] **Step 3: Write the minimal implementation**

Append to `HostApiReads.swift`:

```swift
public struct HostApiOpenChat: Equatable, Sendable {
    public var id: String
    public var title: String
    public var messages: [HostApiChatHistoryResultMessagesItem]
    public var nextBeforeSeq: Int?
}

public struct HostApiReadState: Equatable, Sendable {
    public var sessions: [HostApiChatSessionsResultSessionsItem] = []
    public var nextOffset: Int?
    public var open: HostApiOpenChat?
    public var loading = false
    public var error: String?
    public init() {}
}

/// The phone's chat list and one open chat over Host API v1 `read`. Sends only through the host the owner
/// hands it, and only when `HostApiReadGate` is on for that host.
@MainActor
public final class HostApiReadController {
    public static let maxSessions = 500, maxOpenMessages = 2000, sessionsPage = 50, historyPage = 100

    public private(set) var state = HostApiReadState() {
        didSet { if state != oldValue { onChange?(state) } }
    }
    public var onChange: ((HostApiReadState) -> Void)?

    private let host: () -> HostConnection?
    private var ticket = 0      // the open chat's request generation: a reply for an older open() is dropped
    private var generation = 0  // bumped by reset(): every reply from before a disconnect is dropped
    private var moreBusy = false

    public init(host: @escaping () -> HostConnection?) { self.host = host }

    public func refresh() async {
        await run(.chatSessions, HostApiChatSessionsRequest(limit: Self.sessionsPage), as: HostApiChatSessionsResult.self) { s, r in
            s.sessions = r.sessions; s.nextOffset = r.nextOffset
        }
    }

    public func moreSessions() async {
        guard let offset = state.nextOffset, !moreBusy else { return }
        moreBusy = true
        defer { moreBusy = false }
        await run(.chatSessions, HostApiChatSessionsRequest(limit: Self.sessionsPage, offset: offset),
                  as: HostApiChatSessionsResult.self) { s, r in
            let seen = Set(s.sessions.map(\.id))
            s.sessions = Array((s.sessions + r.sessions.filter { !seen.contains($0.id) }).prefix(Self.maxSessions))
            // At the memory cap there is nothing more to show, so "more" goes away.
            s.nextOffset = s.sessions.count >= Self.maxSessions ? nil : r.nextOffset
        }
    }

    public func open(id: String, title: String) async {
        ticket += 1
        let mine = ticket
        await run(.chatHistory, HostApiChatHistoryRequest(limit: Self.historyPage, sessionId: id),
                  as: HostApiChatHistoryResult.self, current: { [weak self] in self?.ticket == mine }) { s, r in
            s.open = HostApiOpenChat(id: id, title: title, messages: r.messages, nextBeforeSeq: r.nextBeforeSeq)
        }
    }

    public func older() async {
        guard let o = state.open, let beforeSeq = o.nextBeforeSeq else { return }
        let mine = ticket
        await run(.chatHistory, HostApiChatHistoryRequest(beforeSeq: beforeSeq, limit: Self.historyPage, sessionId: o.id),
                  as: HostApiChatHistoryResult.self, current: { [weak self] in self?.ticket == mine }) { s, r in
            guard s.open?.id == o.id else { return }
            s.open = HostApiOpenChat(id: o.id, title: o.title,
                                     messages: Array((r.messages + o.messages).suffix(Self.maxOpenMessages)),
                                     nextBeforeSeq: r.nextBeforeSeq)
        }
    }

    /// Leaving the open chat: its late reply and late error are both dropped.
    public func close() {
        ticket += 1
        state.open = nil
        state.error = nil
    }

    /// Disconnect, a new device, or `read` revoked: forget everything and drop every in-flight reply.
    public func reset() {
        generation += 1
        ticket += 1
        state = HostApiReadState()
    }

    // `current` false = the reply belongs to a chat the user already left: drop its error too, not only its data.
    private func run<P: Encodable, R: Decodable>(_ command: HostApiCommand, _ payload: P, as: R.Type,
                                                 current: @escaping () -> Bool = { true },
                                                 apply: (inout HostApiReadState, R) -> Void) async {
        guard let h = host(), HostApiReadGate.isOn(apiVersion: h.apiVersion, capabilities: h.capabilities) else { return }
        let gen = generation
        state.loading = true
        state.error = nil
        do {
            let r = try await h.send(command, payload, as: R.self)
            guard gen == generation else { return }
            var next = state
            if current() { apply(&next, r) }
            next.loading = false
            state = next
        } catch {
            guard gen == generation else { return }
            var next = state
            next.loading = false
            if current() {
                let text = (error as? HostApiRejection)?.message ?? ""
                next.error = String((text.isEmpty ? "Something went wrong." : text).prefix(500))
            }
            state = next
        }
    }
}
```

- [x] **Step 4: Run the whole package**

Run: `cd /Users/dinsmallade/llm-ide && make test-shared-protocol`
Expected: `generate-host-api.mjs --check` OK, `swift build` OK, all suites PASS including `HostApiReadControllerTests` (6 tests) and `HostApiReadMappingTests` (3 tests). On a Command-Line-Tools-only toolchain the Makefile skips `swift test`; then run `cd ios_app/SharedProtocol && swift test` on a machine with full Xcode (CI does).

- [x] **Step 5: Check the Mac still builds against the package**

Run: `cd /Users/dinsmallade/llm-ide/mac && swift build 2>&1 | tail -5`
Expected: `Build complete!` (no Mac source changed; this proves the additive SharedProtocol types do not collide).

- [x] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiReads.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiReadsTests.swift
git commit -m "feat(ios): Host API v1 read controller with paging, caps and stale-reply guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire reads and v1 usage into the app services

**Files:**
- Modify: `ios_app/MyApp/Services/ConnectionService.swift` (properties block near lines 128-147; `route(_:)` near lines 387-405; `invalidateSocket()` near lines 510-526)
- Modify: `ios_app/MyApp/Services/UsageStore.swift:22-48`
- Modify: `ios_app/MyApp/Views/Control/UsageView.swift:12-18`
- Modify: `ios_app/MyApp/Views/Settings/SettingsView.swift:104`
- Modify: `ios_app/MyApp/Views/RootTabView.swift` (`.onChange(of: connection.macCapabilities)` near line 84-90; `refreshMacData()` near line 106-117)

**Interfaces:**
- Consumes: `HostApiReadController`, `HostApiReadState`, `HostApiReadGate`, `HostApiReadMapping.usageState` (Tasks 1-2).
- Produces (used by Task 4): `ConnectionService.readState: HostApiReadState` (`@Published private(set)`), `ConnectionService.reads: HostApiReadController`, `ConnectionService.servesV1Read: Bool`.

No MyApp test target exists; the logic these lines call is tested in Tasks 1-2. This task's check is the unsigned device build CI runs, plus the v2 rows in Task 4.

- [x] **Step 1: ConnectionService: state, controller, gate**

After the `connectingV1` declaration (line ~142) add:

```swift
    /// Host API v1 `read` (chat list + one chat, read-only). Sends only through the v1 client, never v2.
    @Published private(set) var readState = HostApiReadState()
    private(set) lazy var reads: HostApiReadController = {
        let r = HostApiReadController(host: { [weak self] in self?.v1Client })
        r.onChange = { [weak self] in self?.readState = $0 }
        return r
    }()
    /// True only on a v1 connection whose host granted `read`. Not optimistic, unlike `supports`.
    var servesV1Read: Bool { HostApiReadGate.isOn(apiVersion: hostApiVersion, capabilities: macCapabilities) }
```

- [x] **Step 2: ConnectionService: reset on revoke and disconnect, refresh on resync**

In `route(_:)` change the `.capabilities` and `.event, .progress, .resync` cases to:

```swift
        case .capabilities(let caps):
            macCapabilities = caps
            if !servesV1Read { reads.reset() }   // `read` revoked: clear what is on screen now
            llmIdeStore?.handle(event)
```

```swift
        case .resync:
            llmIdeStore?.handle(event)
            if servesV1Read { Task { await reads.refresh() } }
        case .event, .progress:
            llmIdeStore?.handle(event)
```

In `invalidateSocket()` after `hostApiVersion = 2` add:

```swift
        reads.reset()
```

- [x] **Step 3: UsageStore: `usage.get` on v1**

Replace `refresh()` and `resetForNewDevice()` in `UsageStore.swift` with:

```swift
    private var v1Ticket = 0

    func refresh() {
        guard let connection, connection.connectionStatus == .connected else { return }
        if connection.servesV1Read { return refreshV1(connection) }
        guard connection.supports(MobileProtocol.Capability.usage) else { return }
        connection.sendEncodable(UsageGet())
        loadError = nil
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self, self.state == nil,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with usage."
        }
    }

    /// Host API v1: `usage.get` (capability `read`), mapped into the same `UsageState` the v2 screen shows.
    private func refreshV1(_ connection: ConnectionService) {
        v1Ticket += 1
        let mine = v1Ticket
        loadError = nil
        watchdog?.cancel()
        let host = connection.host
        Task { [weak self] in
            do {
                let r = try await host.send(.usageGet, HostApiUsageGetRequest(), as: HostApiUsageGetResult.self)
                guard let self, mine == self.v1Ticket, self.connection?.servesV1Read == true else { return }
                self.state = HostApiReadMapping.usageState(r)
            } catch {
                guard let self, mine == self.v1Ticket else { return }
                let text = (error as? HostApiRejection)?.message ?? ""
                self.loadError = text.isEmpty ? "Your host sent usage this app could not read." : String(text.prefix(500))
            }
        }
    }

    func resetForNewDevice() {
        v1Ticket += 1
        state = nil
        loadError = nil
        watchdog?.cancel()
    }
```

(The v2 branch is the old body unchanged; on v1 without `read`, `supports("usage")` is false as before, so nothing is sent.)

- [x] **Step 4: UsageView: no permission row when the mode is unknown**

In `UsageView.swift` wrap the first `Section { permissionRow(s.permissionMode) } footer: { … }` (lines 13-17):

```swift
                if !s.permissionMode.isEmpty {
                    Section {
                        permissionRow(s.permissionMode)
                    } footer: {
                        Text("Phone chats run under the Mac's setting. It can only be changed on the Mac.")
                    }
                }
```

(`ContextBar`'s chip already hides: `UsageStore.permissionLabel("")` returns nil.)

- [x] **Step 5: Settings link and RootTabView refresh rules**

`SettingsView.swift:104`:

```swift
                if connection.supports(MobileProtocol.Capability.usage) || connection.servesV1Read {
```

`RootTabView.swift`, in `.onChange(of: connection.macCapabilities)` replace the usage line with:

```swift
            if !connection.supports(MobileProtocol.Capability.usage), !connection.servesV1Read { usageStore.resetForNewDevice() }
```

Replace the body of `refreshMacData()`'s first lines:

```swift
    private func refreshMacData() {
        guard isConnected else { return }
        if connection.servesV1Read {
            usageStore.refresh()
            Task { await connection.reads.refresh() }
        }
        // Host API v1 serves chat, approvals and read only; these stores still speak v2 and would send nothing.
        guard connection.hostApiVersion == 2 else { return }
        macStatusStore.requestMacStatus()
```

(the rest of the function is unchanged).

- [x] **Step 6: Build the app the way ios-ci does**

Run:
```bash
cd /Users/dinsmallade/llm-ide/ios_app && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug \
  -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  SYMROOT="$TMPDIR/ios-build" build 2>&1 | tail -5
```
Expected: `** BUILD SUCCEEDED **`.

- [x] **Step 7: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add ios_app/MyApp/Services/ConnectionService.swift ios_app/MyApp/Services/UsageStore.swift ios_app/MyApp/Views/Control/UsageView.swift ios_app/MyApp/Views/Settings/SettingsView.swift ios_app/MyApp/Views/RootTabView.swift
git commit -m "feat(ios): wire Host API v1 read and usage.get into the app services

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: History tab: chat list, usage strip, read-only history, manual checks

**Files:**
- Create: `ios_app/MyApp/Views/Control/ReadChatsView.swift`
- Modify: `ios_app/MyApp.xcodeproj/project.pbxproj` (4 entries, anchored on the `UsageView.swift` lines 21, 81, 209, 384)
- Modify: `ios_app/MyApp/Views/RootTabView.swift` (`Tab` enum line 23; the `TabView` after the Project tab; a new `.onChange`)
- Modify: `docs/mobile/verification.md` (new section after the "Host API v1 from the iPhone app" table, before `## Security`)

**Interfaces:**
- Consumes: `ConnectionService.readState`, `.reads`, `.servesV1Read` (Task 3); `UsageStore.state`; `UsageView`; `ChatBubble(message:)` and `ChatMessage(historyIndex:role:text:)` (`ConnectionService.swift:33`); `Date(epochSeconds:)` / `relativeTimeShort()` (`Views/Shared/ViewExtensions.swift:22,31`).
- Produces: `struct ReadChatsView: View`, `struct ReadChatHistoryView: View`, `RootTabView.Tab.history`.

- [x] **Step 1: Write the view file**

Create `ios_app/MyApp/Views/Control/ReadChatsView.swift`:

```swift
import SwiftUI
import SharedProtocol

/// Host API v1 `read`: the user's chats on the host, a usage strip, and one chat's history. Read-only:
/// nothing here sends a message or changes which chat the Chat tab talks to.
struct ReadChatsView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var usageStore: UsageStore

    private var state: HostApiReadState { connection.readState }

    var body: some View {
        List {
            if let error = state.error, state.open == nil {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger)
                }
            }
            usageStrip
            Section("Chats") {
                if state.sessions.isEmpty {
                    Text(state.loading ? "Loading chats…" : "No chats on this host yet.")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                ForEach(state.sessions, id: \.id) { s in
                    if s.phoneChat == true {
                        row(s, live: true)
                    } else {
                        NavigationLink { ReadChatHistoryView(id: s.id, title: s.title) } label: { row(s, live: false) }
                            .accessibilityHint("Opens this chat read-only")
                    }
                }
                if state.nextOffset != nil {
                    Button("More chats") { Task { await connection.reads.moreSessions() } }
                        .disabled(state.loading)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("History")
        .refreshable {
            usageStore.refresh()
            await connection.reads.refresh()
        }
        .task {
            if usageStore.state == nil { usageStore.refresh() }
            if state.sessions.isEmpty { await connection.reads.refresh() }
        }
    }

    @ViewBuilder private var usageStrip: some View {
        if let models = usageStore.state?.models, !models.isEmpty {
            Section("Usage") {
                ForEach(Array(models.prefix(3).enumerated()), id: \.offset) { _, m in
                    HStack {
                        Text(m.name).font(DesignSystem.Typography.subheadlineFont).lineLimit(2)
                        Spacer()
                        Text(m.pct.map { "\(Int($0))%" } ?? "No cap")
                            .font(DesignSystem.Typography.subheadlineFont.monospacedDigit())
                            .foregroundColor(m.state == "ok" ? DesignSystem.Colors.textSecondary : DesignSystem.Colors.danger)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(m.name): \(m.detail)")
                }
                NavigationLink("All usage") { UsageView() }
            }
        }
    }

    private func row(_ s: HostApiChatSessionsResultSessionsItem, live: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: s.title).font(DesignSystem.Typography.bodyFont).lineLimit(2)
            Text(live ? "Live chat · on the Chat tab"
                      : Date(epochSeconds: Double(s.updatedAt) / 1000).relativeTimeShort())
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One host chat, read-only. Shown only while `readState.open` is this chat, so a late reply for another
/// chat never paints here.
struct ReadChatHistoryView: View {
    let id: String
    let title: String
    @EnvironmentObject var connection: ConnectionService

    private var open: HostApiOpenChat? { connection.readState.open?.id == id ? connection.readState.open : nil }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: DesignSystem.Spacing.sm) {
                if let error = connection.readState.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger)
                }
                if open?.nextBeforeSeq != nil {
                    Button("Show older") { Task { await connection.reads.older() } }
                        .disabled(connection.readState.loading)
                }
                if let open {
                    ForEach(open.messages, id: \.seq) { m in
                        let assistant = m.role == "assistant"
                        ChatBubble(message: ChatMessage(historyIndex: m.seq, role: assistant ? .assistant : .user, text: m.content))
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel((assistant ? "Assistant: " : "You: ") + m.content)
                    }
                } else if connection.readState.loading {
                    ProgressView("Loading chat…").font(DesignSystem.Typography.footnoteFont)
                }
            }
            .padding(DesignSystem.Spacing.md)
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(verbatim: title).font(DesignSystem.Typography.headlineFont).lineLimit(1)
                    Text("Read-only").font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(title), read-only")
            }
        }
        .task { await connection.reads.open(id: id, title: title) }
        .onDisappear { connection.reads.close() }
    }
}
```

- [x] **Step 2: Add the file to the Xcode project**

First check the ids are free: `grep -c "C2E0A1B2C3D4E5F6000000" /Users/dinsmallade/llm-ide/ios_app/MyApp.xcodeproj/project.pbxproj` → `0`.

In `ios_app/MyApp.xcodeproj/project.pbxproj` insert, each directly after the matching `UsageView.swift` line:

- after line 21 (PBXBuildFile section):
```
		C2E0A1B2C3D4E5F600000002 /* ReadChatsView.swift in Sources */ = {isa = PBXBuildFile; fileRef = C2E0A1B2C3D4E5F600000001 /* ReadChatsView.swift */; };
```
- after line 81 (PBXFileReference section):
```
		C2E0A1B2C3D4E5F600000001 /* ReadChatsView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ReadChatsView.swift; sourceTree = "<group>"; };
```
- after the `B7CC02D68D4369B858A43C3C /* UsageView.swift */,` group child (line ~209, the Control group):
```
				C2E0A1B2C3D4E5F600000001 /* ReadChatsView.swift */,
```
- after the `B8CC02D68D4369B858A43C3C /* UsageView.swift in Sources */,` line in the Sources build phase (line ~384):
```
				C2E0A1B2C3D4E5F600000002 /* ReadChatsView.swift in Sources */,
```

- [x] **Step 3: Add the History tab to RootTabView**

`Tab` enum (line 23):

```swift
    enum Tab: Hashable { case chat, project, history, activity, settings }
```

In the `TabView`, after the `if connection.hasProjectSections { … }` block:

```swift
            if connection.servesV1Read {
                NavigationStack { ReadChatsView() }
                    .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                    .tag(Tab.history)
            }
```

After the existing `.onChange(of: connection.macCapabilities) { … }` modifier add:

```swift
        // v1 dropped, or `read` revoked: the History tab is gone, so never leave the user on it.
        .onChange(of: connection.servesV1Read) { on in
            if !on, selection == .history { selection = .chat }
        }
```

- [x] **Step 4: Build the app the way ios-ci does**

Run:
```bash
cd /Users/dinsmallade/llm-ide/ios_app && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug \
  -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  SYMROOT="$TMPDIR/ios-build" build 2>&1 | tail -5
```
Expected: `** BUILD SUCCEEDED **`. If it fails with "cannot find 'ReadChatsView' in scope", a pbxproj entry from Step 2 is missing.

- [x] **Step 5: Append the manual F-rows to `docs/mobile/verification.md`**

Insert before `## Security`:

```markdown
## Host API v1 reads from the iPhone app (user-run)

Setup: the desktop host with `LLMIDE_HOST_API_READ=1` (plus the DEBUG setup in the section above), and an iPhone paired over v1 **after** the switch was on (a device paired before it must re-pair to get `read`). Plan: `docs/superpowers/plans/2026-11-05-host-api-v1-reads-ios.md`.

| # | Check | Expected |
|---|---|---|
| F19 | Pair over v1 to a host serving `read` | Tabs: Chat, History, Settings. History lists the host's chats newest first; the phone chat row says "Live chat · on the Chat tab" and does not open |
| F20 | Same host without `LLMIDE_HOST_API_READ`, or a device paired before it was on | No History tab; Settings has no "Usage & limits"; nothing calls `chat.sessions`, `chat.history` or `usage.get` (host log) |
| F21 | v2 pairing to the Mac (rows F1-F17) | No History tab; Usage & limits, the permission chip and every v2 screen behave exactly as before |
| F22 | More than 50 chats: tap More chats repeatedly and quickly | Each tap adds one page with no duplicate rows; the button disappears at the end or at 500 chats |
| F23 | Open a long chat, tap Show older until it goes away | Older messages appear above; the view keeps at most the newest 2,000; there is no composer, no Stop, no Clear |
| F24 | Open chat A and immediately go back and open chat B | Only B's messages show; no error from A appears on B or on the list |
| F25 | After reading chat B, send a message from the Chat tab | It goes to the phone chat (visible on the host's phone chat), never to B |
| F26 | Usage strip and Settings → Usage & limits on v1 | Up to 3 meters on the strip, all on the full screen; no permission row or chip; numbers match the web client's Usage |
| F27 | Turn `read` off on the host (restart without the switch) while History is open; also lose the network | History content clears and the app returns to Chat; on reconnect without `read` the tab stays hidden |
| F28 | VoiceOver on: History list, usage strip, a chat; then Settings → Accessibility → Larger Text at the largest size | Each row is read as one element (title + time, meter name + detail, "You:" / "Assistant:" + text, "title, read-only"); text grows and wraps with no clipping |
```

- [x] **Step 6: Run every gate once more**

Run: `cd /Users/dinsmallade/llm-ide && make test-shared-protocol && (cd mac && swift build 2>&1 | tail -1)`
Expected: package tests PASS; Mac `Build complete!`.

- [x] **Step 7: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add ios_app/MyApp/Views/Control/ReadChatsView.swift ios_app/MyApp.xcodeproj/project.pbxproj ios_app/MyApp/Views/RootTabView.swift docs/mobile/verification.md
git commit -m "feat(ios): read-only History tab for Host API v1 chats and usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: usage.get → UsageStore (Tasks 1, 3); chat.sessions paging (Task 2, 4); chat.history read-only (Tasks 2, 4); shown only on v1 + `read` (gate Task 1, used in Tasks 3-4); v2 unchanged (gate false on v2, controller bound to `v1Client`, v2 branch of `UsageStore.refresh` body unchanged, F21); web behaviours (caps 500/2000, ticket, in-flight guard, stale errors dropped) tested in Task 2; accessibility (Task 4 view + F28); manual F-rows (Task 4 Step 5); exact build/test commands (ios-ci's `xcodebuild`, `make test-shared-protocol`).
- Added beyond the web controller: `reset()` with a generation counter (the phone keeps one controller across reconnects, the web disposes it per link) and `close()` clearing the error.
- Known limit: `UsageView` keys `ForEach(s.models)` by meter name (existing v2 code). Two v1 meters with the same label for one provider would share an id; the strip uses offsets, the full screen is unchanged.
