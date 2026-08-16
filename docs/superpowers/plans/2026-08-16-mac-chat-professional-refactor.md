# Mac Chat Professional Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Mac chat into a testable `ChatEngine` + transport + model-v2 architecture shared by all three chat surfaces, with no silent data loss, bounded streaming render cost, and Retry/offline UX.

**Architecture:** Strangler extraction — a new `mac/Sources/LlmIdeMac/Chat/` module owns turn lifecycle, streaming, sessions, and persistence behind a `ChatTransport` protocol; `CodeAssistantPanel` becomes a view over engine state; `LlmChatSheet` and the mobile `explore_chat` proxy adopt the same engine. Message model v2 (stable ids, status, structured tool results) replaces content-string conventions; session files migrate v1→v2 automatically.

**Tech Stack:** Swift 6 (language mode v5), SwiftUI, @Observable, swift-testing (`import Testing`), better-sqlite3 server untouched (wire format unchanged through Task 15).

**Spec:** `docs/superpowers/specs/2026-08-16-mac-chat-professional-refactor-design.md`

## Global Constraints

- Wire format UNCHANGED through Phase 4: the server keeps receiving `{role: "user"|"assistant", content}` turns; `.toolResult` messages are re-encoded as synthetic user turns (spec: Message model v2).
- All 421 existing tests stay green; gate for every task: `cd mac && swift build && swift test`. Final gate: `make test-mac`, `make regression`, `make docs-check`.
- No per-file ESLint-equivalent exemptions; match existing naming (suffix taxonomy: `*Engine` is new — it is stateful orchestration, closest to `*Service`, keep `ChatEngine` as specced).
- Tests use swift-testing: `import Testing`, `@Test`, `#expect`, `@Suite`, in `mac/Tests/LlmIdeMacTests/`.
- Conventional Commits: `test(mac):`, `refactor(mac):`, `feat(mac):`, `docs:`. One concern per commit. Never push to `main` without asking.
- `swift build` failing with "Invalid manifest" is a sandbox artifact — rerun with the sandbox disabled (known issue on this machine).
- Key existing types (do not re-define): `PendingTool` (`mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift:137`), `AgentContext` (same file, line 6), `AgentTask` (line 96), `LlmIdeAPIClient.CodeAssistTurn/CodeAttachment/CodeAssistResponse.Usage` (`mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+CodeAssist.swift`), `AgentAskMessage` (`LlmIdeAPIClient+Agent.swift:117`), `AppJSON` (`mac/Sources/LlmIdeMac/Utilities/AppJSON.swift:10`), `ChatScope`/`ChatSession` (`mac/Sources/LlmIdeMac/Models/ChatSession.swift`), `ChatSessionStore` (`mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift`), `CodeAssistantAgentState` (`mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantAgentState.swift`).
- Deviation from spec's "characterization tests, no prod code moved": the turn lifecycle is view-coupled (`@State`) and cannot be characterized pre-extraction. Phase 1 characterizes every pure seam that IS testable today; engine behavior tests are written failing BEFORE each engine method lands (TDD), which preserves the spec's intent — the engine's contract is pinned before the panel switch in Task 7.

---

### Task 1: Characterize `historyForRequest` packing

**Files:**
- Test: `mac/Tests/LlmIdeMacTests/HistoryForRequestTests.swift`

**Interfaces:**
- Consumes: `CodeAssistantPanel.historyForRequest(_ turns: [LlmIdeAPIClient.CodeAssistTurn]) -> [LlmIdeAPIClient.CodeAssistTurn]` (instance method, pure — reads only its argument and `Self.maxHistoryChars`/`maxHistoryTurnChars`). Instantiating the view struct in a test is safe: `CodeAssistantPanel(api: LlmIdeAPIClient(baseURL: URL(string: "http://127.0.0.1:3456")!), scope: .explorer)` — no @State is touched by this method.
- Produces: the pinned packing contract that Task 9's engine port must satisfy unchanged.

- [ ] **Step 1: Write characterization tests (must PASS against current code)**

```swift
import Testing
@testable import LlmIdeMac

/// Pins the wire-history packing rules from CodeAssistantPanel+Session.swift
/// (historyForRequest, lines 468-499): per-turn clip at 24k, total budget
/// 400k, newest-first packing, first-user-turn anchor always included.
@Suite("historyForRequest packing")
struct HistoryForRequestTests {
    let panel = CodeAssistantPanel(
        api: LlmIdeAPIClient(baseURL: URL(string: "http://127.0.0.1:3456")!),
        scope: .explorer)

    func turn(_ role: LlmIdeAPIClient.CodeAssistRole, _ content: String)
        -> LlmIdeAPIClient.CodeAssistTurn { .init(role: role, content: content) }

    @Test("Under budget: everything passes through, order preserved")
    func underBudget() {
        let turns = [turn(.user, "hello"), turn(.assistant, "hi"), turn(.user, "again")]
        let out = panel.historyForRequest(turns)
        #expect(out.map(\.content) == ["hello", "hi", "again"])
    }

    @Test("Oversized single turn is clipped with marker")
    func perTurnClip() {
        let big = String(repeating: "a", count: CodeAssistantPanel.maxHistoryTurnChars + 500)
        let out = panel.historyForRequest([turn(.user, big)])
        #expect(out.count == 1)
        #expect(out[0].content.count == CodeAssistantPanel.maxHistoryTurnChars
                + "\n…(turn clipped)".count)
        #expect(out[0].content.hasSuffix("…(turn clipped)"))
    }

    @Test("Over total budget: newest turns kept, first user turn anchored")
    func anchorAndTail() {
        // anchor is huge but fits a reserved budget; tail turns are small.
        let anchor = turn(.user, String(repeating: "a", count: 100_000))
        var turns = [anchor]
        for i in 0..<20 { turns.append(turn(.assistant, String(repeating: "b", count: 24_000))) }
        turns.append(turn(.user, "final question"))
        let out = panel.historyForRequest(turns)
        #expect(out.first?.content.hasPrefix("aaaa") == true)          // anchor survives
        #expect(out.last?.content == "final question")                 // newest survives
        let total = out.reduce(0) { $0 + $1.content.count }
        #expect(total <= CodeAssistantPanel.maxHistoryChars)
    }

    @Test("Anchor larger than whole budget is dropped, tail still packed")
    func anchorTooBig() {
        let anchor = turn(.user, String(repeating: "a", count: CodeAssistantPanel.maxHistoryChars + 1))
        let out = panel.historyForRequest([anchor, turn(.user, "small")])
        #expect(out.map(\.content) == ["small"])
    }
}
```

- [ ] **Step 2: Run — expect PASS (characterization)**

Run: `cd mac && swift test --filter HistoryForRequestTests`
Expected: 4 tests PASS. If any FAILS, the assumption about current behavior is wrong — fix the TEST to match reality (never the code), and note the divergence in the commit body.

- [ ] **Step 3: Commit**

```bash
git add mac/Tests/LlmIdeMacTests/HistoryForRequestTests.swift
git commit -m "test(mac): pin historyForRequest packing contract"
```

---

### Task 2: v1 session fixtures for migration

**Files:**
- Test: `mac/Tests/LlmIdeMacTests/ChatSessionV1Fixtures.swift`

**Interfaces:**
- Consumes: `ChatSession` v1 shape `{storeVersion:1, id, scope?, title, createdAt, lastUsedAt, history:[{role,content}]}`.
- Produces: `ChatSessionV1Fixtures` — raw v1 JSON payloads reused by Tasks 8–9 migration tests. Includes the two content conventions migration must convert: `"("`-prefix acks and bash-result turns (`"(bash result - exit code: N)\n$ cmd\n<output>"`, parsed today by `BashResultDisplay.parse`, `CommandOutputView.swift:14-48`).

- [ ] **Step 1: Write the fixture library**

```swift
import Foundation
@testable import LlmIdeMac

/// Raw on-disk v1 session JSON used by migration tests. Shapes lifted from
/// ChatSession.swift (v1 encoder) and the ack conventions in
/// CodeAssistant+Issues/Bash/Git.swift + CodeAssistantPanel+Session.swift.
enum ChatSessionV1Fixtures {
    static func v1JSON(id: String = "11111111-1111-1111-1111-111111111111",
                       historyJSON: String) -> String {
        """
        {"storeVersion":1,"id":"\(id)","scope":"explorer","title":"Fix the parser",
         "createdAt":"2026-08-01T10:00:00Z","lastUsedAt":"2026-08-02T10:00:00Z",
         "history":[\(historyJSON)]}
        """
    }

    /// Ordinary user/assistant exchange.
    static let plainTurns = v1JSON(historyJSON:
        """
        {"role":"user","content":"Why does the scraper miss short captions?"},
        {"role":"assistant","content":"Because `isValidCaption` filters any text under 2 chars."}
        """)

    /// The legacy ack convention: role user, content starting with "(".
    static let ackTurns = v1JSON(historyJSON:
        """
        {"role":"user","content":"(executed create-issue → #42 https://example.com/issues/42)"},
        {"role":"user","content":"(applied update to parser.swift: +3 lines)"},
        {"role":"user","content":"(skipped proposed edit to config.swift)"}
        """)

    /// Bash-result ack — first line carries exit code + command, body is output.
    static let bashTurns = v1JSON(historyJSON:
        """
        {"role":"user","content":"(bash result - exit code: 0)\\n$ npm test\\n\\n3 passing"}
        """)

    /// A stopped turn — the legacy marker is embedded in assistant content.
    static let stoppedTurn = v1JSON(historyJSON:
        """
        {"role":"user","content":"long analysis please"},
        {"role":"assistant","content":"Here is the start of the analysis.\\n\\n_(stopped)_"}
        """)
}
```

- [ ] **Step 2: Verify the fixtures decode as v1 today**

```swift
import Testing
@testable import LlmIdeMac

@Suite("v1 fixture sanity")
struct ChatSessionV1FixtureTests {
    @Test func plainFixtureDecodesAsV1() throws {
        let data = Data(ChatSessionV1Fixtures.plainTurns.utf8)
        let session = try AppJSON.decoder.decode(ChatSession.self, from: data)
        #expect(session.storeVersion == 1)
        #expect(session.history.count == 2)
        #expect(session.history[1].role == .assistant)
    }
}
```

Run: `cd mac && swift test --filter ChatSessionV1FixtureTests` → PASS.

- [ ] **Step 3: Commit**

```bash
git add mac/Tests/LlmIdeMacTests/ChatSessionV1Fixtures.swift
git commit -m "test(mac): v1 session JSON fixtures for migration tests"
```

---

### Task 3: `ChatTransport` protocol + `CodeAssistTransport` + scripted double

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/ChatTransport.swift`
- Test: `mac/Tests/LlmIdeMacTests/CodeAssistTransportTests.swift`

**Interfaces:**
- Consumes: `LlmIdeAPIClient.codeAssistStream` / `codeAssist` (existing); provider-resolution rules from `codeAssistRoundTrip` (`CodeAssistantPanel+Session.swift:323-373`).
- Produces (used by Tasks 4, 11, 12):

```swift
protocol ChatTransport: Sendable {
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult
}
struct ChatTransportInput: Sendable {
    let message: String
    let history: [LlmIdeAPIClient.CodeAssistTurn]
    let attachments: [LlmIdeAPIClient.CodeAttachment]
    let skills: [String]
    let agentContext: AgentContext?
    let language: String?
    let model: String?
    let provider: String?     // resolved via makeProvider(selectedProvider:)
    let mode: String?
    static func makeProvider(selectedProvider: String) -> String  // custom:<uuid> verbatim; else AICliTool.provider
}
struct ChatTransportResult: Sendable, Equatable {
    let reply: String
    let pendingTool: PendingTool?
    let tasks: [AgentTask]?
    let continueNeeded: Bool?
    let usage: LlmIdeAPIClient.CodeAssistResponse.Usage?
    let mode: String?
}
struct CodeAssistTransport: ChatTransport { let api: LlmIdeAPIClient }
```

And the test double (test target):

```swift
/// Scripts one turn: events are delivered in order; `error` (if set) is
/// thrown after the events. Records the input for assertions.
@MainActor
final class ScriptedChatTransport: ChatTransport, @unchecked Sendable {
    enum Step: Sendable { case progress(String, String?); case chunk(String) }  // (label, tool)
    var scripted: [Step] = []
    var result = ChatTransportResult(reply: "", pendingTool: nil, tasks: nil,
                                     continueNeeded: nil, usage: nil, mode: nil)
    var thrownError: Error?
    private(set) var receivedInputs: [ChatTransportInput] = []
    private(set) var progressCountWithSideEffects = 0
    func roundTrip(_ input: ChatTransportInput,
                   onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
                   onChunk: @escaping @MainActor (String) -> Void) async throws -> ChatTransportResult {
        receivedInputs.append(input)
        for step in scripted {
            switch step {
            case .progress(let label, let tool):
                onProgress(.init(label: label, phase: "tool", tool: tool, detail: nil))
            case .chunk(let text): onChunk(text)
            }
        }
        if let e = thrownError { throw e }
        return result
    }
}
```

- [ ] **Step 1: Write failing tests for the fallback rule**

The fallback rule moves verbatim from `codeAssistRoundTrip` (lines 361-372) + the no-progress guard in `codeAssistStream` (LlmIdeAPIClient+CodeAssist.swift:285-298). Test the POLICY as a pure function so the policy is provable without a live server, then keep the thin wrapper:

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@Suite("CodeAssistTransport fallback policy")
struct CodeAssistTransportTests {
    @Test("makeProvider passes custom:uuid verbatim")
    func customProvider() {
        #expect(ChatTransportInput.makeProvider(selectedProvider: "custom:ABC-123") == "custom:ABC-123")
    }

    @Test("makeProvider maps a built-in tool id to its provider string")
    func builtinProvider() {
        let p = ChatTransportInput.makeProvider(selectedProvider: AICliTool.claudeCode.rawValue)
        #expect(p == AICliTool.claudeCode.provider)
    }

    @Test("Fallback policy: .http with no progress → retry buffered; anything else → rethrow")
    func fallbackPolicy() {
        #expect(CodeAssistTransport.shouldFallbackBuffered(error: APIError.http(status: 502, code: "BAD", message: "x", details: nil),
                                                           sawProgress: false) == true)
        #expect(CodeAssistTransport.shouldFallbackBuffered(error: APIError.http(status: 502, code: "BAD", message: "x", details: nil),
                                                           sawProgress: true) == false)
        #expect(CodeAssistTransport.shouldFallbackBuffered(error: APIError.agent(message: "server agent error"),
                                                           sawProgress: false) == false)
    }
}
```

Note: `APIError.http` has signature `(status: Int, code: String, message: String, details: [String: String]?)` — check the actual case in `LlmIdeAPIClient.swift:6-66` before writing and adapt the test to the real associated values.

- [ ] **Step 2: Run — expect FAIL (types don't exist)**

Run: `cd mac && swift test --filter CodeAssistTransportTests` → compile error.

- [ ] **Step 3: Implement `ChatTransport.swift`**

Move the body of `codeAssistRoundTrip` into `CodeAssistTransport.roundTrip`:
- provider resolution → `ChatTransportInput.makeProvider(selectedProvider:)` (from lines 330-338),
- SSE call with `onProgress` passthrough and `onChunk` passthrough (from lines 341-360, minus the `turnActivity` recording — that moves to the engine in Task 4),
- catch-fallback (lines 361-372) gated by the new pure `static func shouldFallbackBuffered(error: APIError, sawProgress: Bool) -> Bool`, where `sawProgress` is threaded out of `codeAssistStream` — add a `sawProgress` output: change `codeAssistStream` to take an optional `@MainActor (Bool) -> Void` observer OR (simpler, do this) have `codeAssistStream` throw `.agent` when progress was seen and the stream died (it already does — LlmIdeAPIClient+CodeAssist.swift:285-298), so `shouldFallbackBuffered(error:sawProgress:)` only needs the error kind: `.http` → true, everything else → false. Then the `sawProgress` parameter is unnecessary — drop it and encode the rule as `.http → retry buffered once, else rethrow`.

Do NOT delete `codeAssistRoundTrip` from the panel yet (Task 7 does); have the panel call `CodeAssistTransport(api:).roundTrip(...)` via a small adapter OR leave the panel untouched this task and only add the new file — choose: add the new file, leave the panel calling its own copy for now. Duplication exists for exactly one task; Task 7 deletes the panel copy.

- [ ] **Step 4: Run tests** → `swift test --filter CodeAssistTransportTests` → PASS. Then `swift test` (whole suite green).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/ChatTransport.swift mac/Tests/LlmIdeMacTests/CodeAssistTransportTests.swift
git commit -m "refactor(mac): ChatTransport seam with side-effect-safe fallback policy"
```

---

### Task 4: `ChatEngine` — send / stop / stream / queue

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/ChatEngine.swift`
- Test: `mac/Tests/LlmIdeMacTests/ChatEngineTurnTests.swift`

**Interfaces:**
- Consumes: `ChatTransport`, `ScriptedChatTransport`, `CodeAssistantAgentState`, `ChatSessionStore` (still sync at this stage).
- Produces (used by Tasks 5, 6, 7, 9, 11, 12, 14, 15, 16):

```swift
@MainActor @Observable
final class ChatEngine {
    struct QueuedMessage: Identifiable, Equatable { let id = UUID(); let text: String; let skillIds: [String] }
    // Observable state (moved 1:1 from the panel)
    private(set) var history: [LlmIdeAPIClient.CodeAssistTurn] = []
    private(set) var busy = false
    private(set) var statusText = ""
    private(set) var error: String?
    private(set) var queued: [QueuedMessage] = []
    private(set) var revealingTurnID: UUID?
    private(set) var revealedCount = 0
    private(set) var runTask: Task<Void, Never>?
    private(set) var sessionEpoch: UInt = 0
    let agent = CodeAssistantAgentState()      // engine owns it; panel reads the same object
    // Injected collaborators — the panel wires these in Task 7
    var buildContext: () async -> AgentContext = { AgentContext() }
    var sendAnnouncement: (String) -> Void = { _ in }   // VoiceOver hook, test-quiet by default
    var resolveTransportInput: (String, [LlmIdeAPIClient.CodeAssistTurn], [LlmIdeAPIClient.CodeAttachment], [String]) async -> ChatTransportInput  // message, history, attachments, skills → input (fills language/model/provider/mode from panel state)
    let transport: ChatTransport
    init(transport: ChatTransport)
    // Turn lifecycle — bodies moved from CodeAssistantPanel+Session.swift
    func startTurn(_ message: String, skillIds: [String] = [])
    func stop()
    func runTurn(_ message: String, skillIds: [String] = []) async   // lines 105-197
    func sendFollowup() async                                        // lines 392-449
    func unblockAndFollowUp() async                                  // lines 387-390
    func beginStreamingTurn() -> UUID                                // lines 660-668
    func appendStreamedChunk(_ id: UUID, _ text: String)             // lines 677-681
    func finishStreamingTurn(_ id: UUID, pendingTool: PendingTool?, tasks: [AgentTask]?,
                             continueNeeded: Bool?, usage: LlmIdeAPIClient.CodeAssistResponse.Usage?,
                             mode: String?, stopped: Bool)            // lines 689-770
    func enqueue(_ text: String, skillIds: [String])
}
```

- [ ] **Step 1: Write failing engine tests** (these pin the semantics documented in the source comments — they are the real characterization suite)

```swift
import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("ChatEngine turn lifecycle")
struct ChatEngineTurnTests {
    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(transport: t)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        return (engine, t)
    }

    @Test("Happy path: user turn, streamed chunks, finalize done")
    func happyPath() async {
        let (engine, t) = makeEngine()
        t.scripted = [.chunk("Hel"), .chunk("lo")]
        t.result = .init(reply: "Hello", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("hi")
        #expect(engine.history.map(\.role) == [.user, .assistant])
        #expect(engine.history[1].content == "Hello")
        #expect(engine.busy == false)
        #expect(engine.revealingTurnID == nil)
        #expect(engine.error == nil)
    }

    @Test("Stop mid-stream keeps partial text, marks stopped, no error")
    func stopMidStream() async {
        let (engine, t) = makeEngine()
        t.scripted = [.chunk("partial answer")]
        t.thrownError = CancellationError()
        await engine.runTurn("hi")
        #expect(engine.history[1].content.contains("partial answer"))
        #expect(engine.history[1].content.contains("_(stopped)_"))
        #expect(engine.error == nil)
    }

    @Test("Real failure surfaces error and finalizes placeholder")
    func failure() async {
        let (engine, t) = makeEngine()
        t.thrownError = APIError.network(underlying: nil, message: "down")  // adapt to real APIError cases
        await engine.runTurn("hi")
        #expect(engine.error != nil)
        #expect(engine.history.last?.role == .assistant)
        #expect(engine.revealingTurnID == nil)
    }

    @Test("Queue drains after completion, in FIFO order, one per turn")
    func queueDrain() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "ok", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        engine.enqueue("first", skillIds: [])
        engine.enqueue("second", skillIds: [])
        await engine.runTurn("zero")
        // runTurn's tail starts a fresh Task for "first"; pump the main queue
        await Task.yield()
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(engine.queued.isEmpty || engine.queued.map(\.text) == ["second"])
        let userTexts = engine.history.filter { $0.role == .user }.map(\.content)
        #expect(userTexts.contains("zero"))
    }

    @Test("Tool progress is deduped and recorded per turn")
    func toolSteps() async {
        let (engine, t) = makeEngine()
        t.scripted = [.progress("Reading Foo.swift", "read-file"),
                      .progress("Reading Foo.swift", "read-file"),
                      .progress("Running npm test", "bash")]
        t.result = .init(reply: "done", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("go")
        // Task 4 keeps the dict shape; Task 9 moves it into the message.
        // Expose engine.turnActivity for now (moved 1:1 from the panel).
        let steps = engine.turnActivity[engine.history[1].id] ?? []
        #expect(steps.map(\.label) == ["Reading Foo.swift", "Running npm test"])
    }
}
```

Before writing, check `APIError`'s real cases (`LlmIdeAPIClient.swift:6-66`) and adapt the failure test — do not invent case names.

- [ ] **Step 2: Run — FAIL (no ChatEngine)**

- [ ] **Step 3: Implement ChatEngine by MOVING code**

Move from `CodeAssistantPanel+Session.swift` (do not rewrite logic):
- `runTurn` (105-197): replace `history`/`busy`/`statusText`/`error`/`agent`/`sessionEpoch` @State refs with engine ivars; replace the `codeAssistRoundTrip` call with `transport.roundTrip(input, onProgress:onChunk:)`; move the `onProgress` body (statusText + turnActivity dedup, lines 346-359) into the engine's call site; `session.record/shouldNudge` — the panel's `CodeAssistantSession` stays panel-owned in this task; the engine takes `var onRecordPrompt: (String) -> Void = { _ in }` and `var onNudge: (String) -> Void = { _ in }`, wired in Task 7.
- `beginStreamingTurn`/`appendStreamedChunk`/`finishStreamingTurn` (660-770) verbatim, with `suppressHistoryAnnounce` replaced by an engine ivar and VoiceOver posting via `sendAnnouncement`; the auto-continue block (740-761) moves inside `finishStreamingTurn` as-is (epoch + busy guards), calling `self.startTurn("Continue working on your pending tasks.")`.
- `sendFollowup`/`unblockAndFollowUp` (375-449) verbatim.
- `startTurn`/`stop` (91-100) verbatim.
- `autoChainPendingAction` call sites in runTurn/sendFollowup: engine exposes `var autoChain: ((PendingTool?, LlmIdeAPIClient.CodeAssistResponse.Usage?) async -> Void)?` — Task 7 wires the panel's implementation; engine calls `await autoChain?(resp.pendingTool, usage: resp.usage)`.
- `turnActivity`, `turnModes`, `bubbleHeights` dictionaries + `QueuedMessage` move into the engine (panel keeps `@Bindable` access).

The panel still compiles: its `+Session.swift` copies remain until Task 7. Add the file to the target (SPM auto-includes `Sources/`).

- [ ] **Step 4: Run engine tests + full suite** → PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Chat/ChatEngine.swift mac/Tests/LlmIdeMacTests/ChatEngineTurnTests.swift
git commit -m "refactor(mac): ChatEngine turn lifecycle extracted from panel (TDD)"
```

---

### Task 5: Auto-chain policy as pure decisions

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/ChatEngine+AutoChain.swift`
- Test: `mac/Tests/LlmIdeMacTests/ChatAutoChainPolicyTests.swift`

**Interfaces:**
- Consumes: `EditAcceptanceMode`, `PendingTool.UpdateFileArgs`/`GitOpArgs`/`BashArgs`, `shouldAutoRunGitOp` (in `CodeAssistant+Git.swift`).
- Produces:

```swift
enum ChatAutoChainDecision: Equatable {
    case autoApplyEdit            // resolveEdit + confirmUpdateFile
    case requireManualReview(reason: String?)  // card stays; reason surfaced when truncated
    case autoRunGitOp
    case autoRunBash
    case none
}
enum ChatAutoChainPolicy {
    static func decide(pendingTool: PendingTool?, editMode: EditAcceptanceMode,
                       autoOpsUsed: Int, maxAutoOpsPerTurn: Int,
                       truncatedPaths: Set<String>,
                       isWholeFileRewrite: Bool,
                       matchPath: String?) -> [ChatAutoChainDecision]
}
```

- [ ] **Step 1: Failing tests — the decision table**

```swift
import Testing
@testable import LlmIdeMac

@Suite("Auto-chain policy")
struct ChatAutoChainPolicyTests {
    @Test("Review mode never auto-applies an edit")
    func reviewMode() {
        let d = ChatAutoChainPolicy.decide(pendingTool: nil, editMode: .review, autoOpsUsed: 0,
                                           maxAutoOpsPerTurn: 10, truncatedPaths: [],
                                           isWholeFileRewrite: true, matchPath: nil)
        #expect(d.isEmpty || d == [.none])
    }
    // Build PendingTool fixtures with .updateFileArgs(content: "full rewrite")
    // and .bashArgs — see AgentTypes.swift:137 for the exact initializer shape.
    @Test("Auto mode + whole-file rewrite + truncated path → manual review with reason")
    func truncatedGuard() { /* pendingTool=updateFile(content), editMode=.auto, truncatedPaths=[path], matchPath=path → [.requireManualReview(reason: non-nil)] */ }
    @Test("Auto mode + anchored edit on truncated file → still auto-applies")
    func anchoredEditSafe() { /* isWholeFileRewrite=false, truncated → [.autoApplyEdit] */ }
    @Test("Budget exhausted → no further auto ops")
    func budget() { /* autoOpsUsed == max → no autoApplyEdit/autoRunBash */ }
    @Test("Bash proposal in auto mode within budget → autoRunBash")
    func bash() { /* pendingTool=bashArgs → [.autoRunBash] */ }
}
```

Fill every `/* */` with real assertions before running — a test with an unfilled comment is a plan failure.

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** by extracting the branch structure of `autoChainPendingAction` (`CodeAssistantPanel+Session.swift:508-574`) into the pure function. The panel's `autoChainPendingAction` becomes a thin executor: call `decide(...)`, then act (resolveEdit/confirmUpdateFile/runGitOpFlow/runBashCommand) in order. Truncated-path data comes from `usage.truncatedPaths`; `matchPath` from `matchingAttachment(for:allowBasenameFallback:false)?.path`; `isWholeFileRewrite` from `args.content != nil`.
- [ ] **Step 4: Run tests + full suite** → PASS
- [ ] **Step 5: Commit** — `refactor(mac): auto-chain policy as pure, testable decisions`

---

### Task 6: Session management moves into the engine

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Chat/ChatEngine.swift`
- Test: `mac/Tests/LlmIdeMacTests/ChatEngineSessionTests.swift`

**Interfaces:**
- Consumes: `ChatSessionStore` (sync API unchanged this task), pointer key `"chat.current.<scope>"`.
- Produces (Task 7 wires the panel to these):

```swift
extension ChatEngine {
    var scope: ChatScope { get }
    var sessions: [ChatSession] { get }
    var currentSessionIDString: String { get }
    func handleOnAppearSessions() -> [LlmIdeAPIClient.CodeAssistTurn]   // pointer resolve/load/mint logic, CodeAssistantPanel.swift:419-439; returns history to load
    func persistCurrentChat()                                           // from +Session.swift:586-602 (50-cap unchanged this task)
    func refreshSessions(); func renameSession(_:to:); func rememberCurrentPointer()
    func createNewSession(); func switchSession(to:); func deleteSession(_:); func mintFreshSession()
    func resetActiveTurnState(); func resetTransientSessionState()
    var suppressHistoryAnnounce: Bool { get set }   // engine-owned; panel's onReceive reload paths set it
}
```

- [ ] **Step 1: Failing tests**

```swift
@MainActor @Suite("ChatEngine sessions")
struct ChatEngineSessionTests {
    // ChatSessionStore.baseDirectoryOverride = temp dir in suite setup;
    // restore nil in teardown (existing ChatSessionStoreTests pattern).
    @Test("switchSession bumps epoch — a scheduled auto-continue from the old session no-ops")
    func epochBump() async { /* engine.startTurn via scripted continueNeeded result;
                               engine.switchSession(to: other);
                               advance past the 0.8s asyncAfter (inject the delay:
                               engine.continueDelayNanos = 0);
                               assert no new turn started for the OLD session id */ }
    @Test("deleteSession(active) falls back to newest remaining, else mints fresh")
    func deleteFallback() { /* two sessions, delete active → currentSessionIDString == survivor; delete last → fresh id, empty history */ }
    @Test("resetActiveTurnState finalizes an in-flight placeholder synchronously")
    func syncFinalize() { /* begin a streaming turn, call resetActiveTurnState()
                             WITHOUT awaiting; revealingTurnID == nil immediately and
                             the placeholder content ends with _(stopped)_ */ }
    @Test("deleteSession fires session-memory forget (injected closure)")
    func forgetMemory() { /* engine.forgetSessionMemory: (String) async -> Void hook;
                             assert it receives the session id (Task 7 wires api.forgetSessionMemory) */ }
}
```

Add `var continueDelayNanos: UInt64 = 800_000_000` and `var forgetSessionMemory: (String) async -> Void = { _ in }` to the engine so tests don't sleep or hit the network. The `Task.detached` fire-and-forget in the current `deleteSession` (+Session.swift:865-868) becomes a call to the injected closure.

- [ ] **Step 2: FAIL → Step 3: move** `persistCurrentChat/refreshSessions/renameSession/rememberCurrentPointer/resetActiveTurnState/resetTransientSessionState/mintFreshSession/createNewSession/switchSession/deleteSession/clearCurrentChat` (+Session.swift:576-895) into the engine. `switchSession`/`deleteSession` keep calling `rebuildSentPrompts`-equivalent via hook `var onHistoryReplaced: ([LlmIdeAPIClient.CodeAssistTurn]) -> Void` (panel rebuilds ↑-recall). `loadLanguage` stays in the panel (it's a pref fetch, not chat state).
- **Step 4: PASS + full suite → Step 5: Commit** `refactor(mac): session management moves into ChatEngine`

---

### Task 7: Panel delegates to the engine

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift` (replace @State block lines 81-235 chat-owned subset), `CodeAssistantPanel+Session.swift` (DELETE moved methods: 90-197, 202-231 stays until Task 10 for confirmers' synthetic appends — keep `confirmCreateIssue`/`confirmUpdateFile` but route history appends through engine, 319-373, 375-449, 508-574 executor, 576-895, 897-904 keep), `ChatMessageList.swift`, `ChatComposer.swift`, `CodeAssistant+Sheets.swift` (call-sites only)
- Test: no new tests; the gate is the full suite + build.

**Interfaces:**
- Consumes: everything Tasks 3-6 produced.
- Produces: `CodeAssistantPanel` holding `@State var engine: ChatEngine?` — no. Use `@State private var engine = ChatEngine(transport: CodeAssistTransport(api:))`… the panel needs `api` before init; `api` is a `let` property, so `@State var engine: ChatEngine!` set in `handleOnAppear` is fragile. Instead: `init(api:scope:...)` custom initializer creating `@State` initial value via `_engine = State(initialValue: ChatEngine(transport: CodeAssistTransport(api: api)))` — SwiftUI allows this in init. Panel wires hooks there: `engine.buildContext = { [weak …] await buildAgentContext() }` needs other env objects not yet available in init — so wire env-dependent hooks in `.onAppear`/`.task` (idempotent). Subviews receive the engine: `ChatMessageList(engine: engine, …)` replacing the 20+ params one group at a time.

- [ ] **Step 1:** In `CodeAssistantPanel.init`, create the engine; delete the moved `@State` declarations (`history, busy, statusText, runTask, queued, error, bubbleHeights, turnModes, turnActivity, revealingTurnID, revealedCount, currentSessionIDString, sessions, sessionEpoch, suppressHistoryAnnounce, autoGitOpsThisTurn, agent`); keep view state (`draft, sentPrompts, historyIndex, draftStash, expandedTurns, showingSessionPicker, sessionSearchQuery, attachmentState, modelState, sheets, voiceState, voiceService, completion, session, panelWidth, …`).
- [ ] **Step 2:** Replace every moved-method call site with `engine.` (grep the panel dir for each name: `runTurn|startTurn|sendFollowup|unblockAndFollowUp|stop()|beginStreamingTurn|appendStreamedChunk|finishStreamingTurn|persistCurrentChat|refreshSessions|renameSession|createNewSession|switchSession|deleteSession|mintFreshSession|clearCurrentChat|resetActiveTurnState|resetTransientSessionState|rememberCurrentPointer|historyForRequest|maxHistoryChars`). `historyForRequest` moves into the engine unchanged (its tests still target the panel method — update Task 1's tests to call `engine.historyForRequest`; the panel keeps a forwarding computed property OR update the test call sites; prefer moving the test to the engine and deleting the panel copy).
- [ ] **Step 3:** Wire hooks in `.task`/`onAppear`: `engine.buildContext`, `engine.resolveTransportInput` (captures `prefLanguage`, `modelState`, provider rules), `engine.autoChain = { pt, usage in await autoChainExecutor(pt, usage:) }` (the thin executor from Task 5), `engine.onRecordPrompt = { session.record(prompt: $0); if session.shouldNudge(for: $0) { agent.nudgePrompt = $0 } }`, `engine.forgetSessionMemory = { try? await api.forgetSessionMemory(sessionId: $0) }`, `engine.onHistoryReplaced = { rebuildSentPrompts(from: $0) }`, `engine.sendAnnouncement = { text in NSAccessibility.post(...) }`.
- [ ] **Step 4:** `handleHistoryChange` (panel, lines 466-484) becomes: `engine.announceAndPersist()` — move the announcement+persist logic into the engine (`onChange(of: engine.history)` in the panel). The `.explorerChatTranscriptChanged` onReceive (lines 278-290) rewrites `engine.history` via an engine method `reloadFromDisk(id:)`.
- [ ] **Step 5:** `swift build && swift test` — full suite green (Task 1's tests updated to the engine in Step 2). Manual smoke per `memory/running-mac-app-for-observation.md`: `cd mac && swift build -c release` is NOT needed; `swift build && open .build/debug/LlmIdeMac.app` if a UI check is wanted — GUI clicks need Accessibility permission.
- [ ] **Step 6: Commit** `refactor(mac): panel delegates turn/session lifecycle to ChatEngine` — this is the behavior-identical switchover; if any test needed changing BEYOND call-site updates, stop and flag.

---

### Task 8: `ChatMessage` model + v2 envelope + migration

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/ChatMessage.swift`
- Modify: `mac/Sources/LlmIdeMac/Models/ChatSession.swift` (v2 envelope)
- Test: `mac/Tests/LlmIdeMacTests/ChatMessageMigrationTests.swift`

**Interfaces:**
- Produces:

```swift
struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable { case user, assistant, toolResult }
    enum Status: String, Codable { case streaming, done, stopped, failed }
    struct ToolStep: Codable, Equatable, Identifiable, Sendable {
        let id: UUID; let label: String; let tool: String?; let at: Date
        var icon: String { /* copy the SF Symbol switch from CodeAssistantPanel.ToolStep (lines 130-143) */ }
    }
    struct ToolResultPayload: Codable, Equatable, Sendable {
        enum Kind: String, Codable { case edit, bash, git, issue, skip, other }
        let kind: Kind
        var summary: String        // human line shown in the capsule ("applied update to parser.swift: +3 lines")
        var exitCode: Int?         // bash
        var command: String?       // bash
        var output: String?        // bash (full, beyond the first line)
        var url: String?           // issue/PR
    }
    struct Metadata: Codable, Equatable, Sendable {
        var mode: String?
        var usage: LlmIdeAPIClient.CodeAssistResponse.Usage?
        var skills: [String]?
        var failedError: String?
        var retryPayload: RetryPayload?
    }
    struct RetryPayload: Codable, Equatable, Sendable {
        let message: String; let skillIds: [String]
    }
    let id: UUID
    let role: Role
    var content: String
    var status: Status
    let createdAt: Date
    var toolSteps: [ToolStep]
    var toolResult: ToolResultPayload?   // role == .toolResult
    var metadata: Metadata?
    // Wire encoding — THE server contract (spec: unchanged):
    func wireTurn() -> LlmIdeAPIClient.CodeAssistTurn
}
```

`ChatSession` v2: `storeVersion = 2`, `history` renamed `messages: [ChatMessage]`, custom `init(from:)` accepting BOTH: v2 (`messages` key) and v1 (`history` key of `{role,content}`), migrating v1 via `ChatMessage.migrate(role:content:sessionDate:)`:
- content starting with `"(bash result - exit code: N)"` → `.toolResult` with parsed payload (reuse the regex from `BashResultDisplay.parse`, CommandOutputView.swift:14-48 — move that parser INTO `ToolResultPayload.parse(content:)` and keep behavior identical),
- other `"("`-prefix user content → `.toolResult` (kind inferred: contains "executed create-issue"/"applied update"/"skipped"/else `.other`; summary = first line),
- assistant content ending `"\n\n_(stopped)_"` → `.stopped` with the suffix stripped,
- everything else → `.done` (users) / `.done` (assistants), `createdAt = session.lastUsedAt`.

- [ ] **Step 1: Failing migration tests using Task 2 fixtures**

```swift
@Suite("ChatMessage v1→v2 migration")
struct ChatMessageMigrationTests {
    @Test func plainTurnsMigrate() throws {
        let s = try decode(ChatSessionV1Fixtures.plainTurns)
        #expect(s.storeVersion == 2)
        #expect(s.messages.count == 2)
        #expect(s.messages[0].role == .user && s.messages[0].status == .done)
        #expect(s.messages[0].id == s.messages[0].id)  // stability within one decode
    }
    @Test func ackTurnsBecomeToolResults() throws {
        let s = try decode(ChatSessionV1Fixtures.ackTurns)
        #expect(s.messages.allSatisfy { $0.role == .toolResult })
        #expect(s.messages[0].toolResult?.kind == .issue)
        #expect(s.messages[1].toolResult?.kind == .edit)
        #expect(s.messages[2].toolResult?.kind == .skip)
    }
    @Test func bashTurnParsesExitCodeAndCommand() throws {
        let s = try decode(ChatSessionV1Fixtures.bashTurns)
        let p = try #require(s.messages[0].toolResult)
        #expect(p.kind == .bash); #expect(p.exitCode == 0); #expect(p.command == "npm test")
        #expect(p.output?.contains("3 passing") == true)
    }
    @Test func stoppedMarkerBecomesStatus() throws {
        let s = try decode(ChatSessionV1Fixtures.stoppedTurn)
        let last = try #require(s.messages.last)
        #expect(last.status == .stopped)
        #expect(!last.content.contains("_(stopped)_"))
    }
    @Test func wireTurnResynthesizesLegacyText() throws {
        let s = try decode(ChatSessionV1Fixtures.bashTurns)
        let wire = s.messages.map(\.wireTurn)
        #expect(wire[0].role == .user)   // server still sees user/assistant only
        #expect(wire[0].content.hasPrefix("(bash result - exit code: 0)"))
    }
    @Test func v2RoundTripKeepsIds() throws {
        let s = try decode(ChatSessionV1Fixtures.plainTurns)
        let data = try AppJSON.encoder.encode(s)
        let s2 = try AppJSON.decoder.decode(ChatSession.self, from: data)
        #expect(s.messages.map(\.id) == s2.messages.map(\.id))
    }
    private func decode(_ json: String) throws -> ChatSession {
        try AppJSON.decoder.decode(ChatSession.self, from: Data(json.utf8))
    }
}
```

- [ ] **Step 2: FAIL → Step 3: implement `ChatMessage.swift` + ChatSession v2 decoder.** Keep `ChatSessionStore.list/load/save` compiling: they reference `session.history` — rename all uses to `messages` (store file + panel call sites via compile errors; grep `\.history` under Sources/ for `ChatSession`-typed uses — careful: `engine.history` (turns) is distinct; rename engine's to `messages` in Task 9, not now. In Task 8 the SESSION struct changes; the ENGINE still holds `[CodeAssistTurn]` and converts at the persist boundary via `messages.map(\.wireTurn)` → NO. Cleanest Task 8 boundary: `ChatSession.messages: [ChatMessage]`; `persistCurrentChat` (engine) encodes `history.map(ChatMessage.fromWireTurn)`; `load` paths decode and map `messages.map(\.wireTurn)` into engine.history. Migration thus runs transparently on load, and files rewrite as v2 on next save.)
- [ ] **Step 4: PASS + full suite (existing ChatSessionStoreTests updated to v2 field name — assertion changes only, same behaviors) → Step 5: Commit** `feat(mac): ChatMessage v2 with automatic v1 session migration`

---

### Task 9: Engine + views on `ChatMessage`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Chat/ChatEngine.swift` (history: `[ChatMessage]`), `ChatMessageList.swift`, `ChatComposer.swift` (submit/queue), `CodeAssistantPanel.swift`, `CodeAssistantPanel+Session.swift` confirmers, `HistoryForRequestTests.swift` (target the message-based packer)
- Test: `mac/Tests/LlmIdeMacTests/ChatEngineMessageTests.swift`

**Interfaces:**
- Consumes: `ChatMessage`, `wireTurn()`.
- Produces: `engine.messages: [ChatMessage]`; `engine.historyForRequest(_ msgs: [ChatMessage]) -> [LlmIdeAPIClient.CodeAssistTurn]` (same packing rules; encode: `.user`/`.assistant` → wire turn; `.toolResult` → `.user` with `toolResult.summary` re-rendered as the legacy synthetic line — a NEW static `ToolResultPayload.legacyContent()` must produce byte-identical formats for bash (`"(bash result - exit code: N)\n$ cmd\n…"`) and the other kinds (`"(…)"` first lines) so server-side prompt continuity is preserved mid-session across the upgrade).

- [ ] **Step 1: Failing tests:** (a) `historyForRequest` packing on `[ChatMessage]` — port Task 1's four tests; (b) `legacyContent()` round-trip: for every fixture from Task 2, `migrate(v1).toolResult.legacyContent() == original v1 content` (byte-identical — this is the safety net that the server prompt can't drift across the upgrade); (c) engine `finishStreamingTurn(stopped: true)` sets `.stopped` WITHOUT touching content; (d) a failing send leaves the placeholder `.failed` with `metadata.failedError != nil` (behavior NEW — wire in Task 16's UI, but the status lands now).
- [ ] **Step 2: FAIL → Step 3: implement.** Engine internals swap `CodeAssistTurn` → `ChatMessage`: `beginStreamingTurn` appends `.streaming` message; `appendStreamedChunk` mutates content; `finishStreamingTurn` sets `.done`/`.stopped` + `toolSteps`/`metadata.mode`/`metadata.usage` on the message — DELETE `turnActivity`/`turnModes` dicts and the panel `ToolStep` struct. `ChatMessageList`: `isToolNotice` → `msg.role == .toolResult`; stopped rendering keys off `status`; `bubbleHeights` stays a panel dict keyed by message id (now stable). The `"_(stopped)_"` append in the engine is deleted.
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `refactor(mac): engine and views on ChatMessage; string conventions deleted`

---

### Task 10: Structured acknowledgements

**Files:**
- Modify: `CodeAssistantPanel+Session.swift` (`confirmCreateIssue` 202-231, `confirmUpdateFile` 265-316), `CodeAssistant+Bash.swift`, `CodeAssistant+Git.swift`, `CodeAssistant+Issues.swift`, `CodeAssistant+PR.swift`, `ChatMessageList.swift`, `CommandOutputView.swift`
- Test: `mac/Tests/LlmIdeMacTests/ChatAcknowledgeTests.swift`

**Interfaces:**
- Produces: `extension ChatEngine { func acknowledge(_ payload: ChatMessage.ToolResultPayload, followUp: Bool) async }` — appends `.toolResult` message, optionally `sendFollowup()`. `CommandOutputView` gains `init(message: ChatMessage)` reading `toolResult` directly.

- [ ] **Step 1: Failing tests:** `acknowledge(.edit summary:"applied update to a.swift: +3 lines", followUp: true)` appends one `.toolResult` message and starts a follow-up (transport receives `(continue)` — assert via `ScriptedChatTransport.receivedInputs.last?.message`); `acknowledge(bash payload, followUp: false)` appends and does NOT call the transport.
- [ ] **Step 2: FAIL → Step 3:** each confirmer builds a `ToolResultPayload` instead of the `"("` string and calls `engine.acknowledge`; `CommandOutputView.init(message:)` renders from the struct (keep the old string init until ChatMessageList switches, then delete it and `BashResultDisplay.parse` — `legacyContent()` already guarantees the migration path). `rebuildSentPrompts` drops the `hasPrefix("(")` skip in favor of `role != .toolResult`; `prevUserPrompt` in ChatMessageList likewise.
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `refactor(mac): structured tool acknowledgements replace "(" string convention`

---

### Task 11: `AgentAskTransport` + LlmChatSheet on the engine

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/AgentAskTransport.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Shell/LlmChatSheet.swift`
- Test: `mac/Tests/LlmIdeMacTests/AgentAskTransportTests.swift`

**Interfaces:**
- Consumes: `api.askAgent(message:history:images:model:provider:)`, `api.listAgentAskHistory(limit:)`.
- Produces: `struct AgentAskTransport: ChatTransport` — `roundTrip` calls `askAgent` with `input.history` (wire turns), never invokes `onProgress`/`onChunk`, returns `ChatTransportResult(reply: nil-pendingTool …)`. `LlmChatSheet` holds `@State var engine: ChatEngine` (created in `init(api:)` with `AgentAskTransport`), renders `SelfSizingMarkdownView` for assistant bubbles (user bubbles stay plain `Text`), gains a Stop button (`engine.stop()`; while `busy` the send button becomes a stop button like the main panel), keeps the 2s polling `loadHistory` (now writes `engine.messages` via `engine.replaceMessages(_ msgs: [ChatMessage])` — messages derived from `AgentAskHistoryItem` with `role` mapping and stable `seq`-derived ids: `UUID(uuidString:)` can't take an int — derive `id = UUID(namespace: fixedNamespace, name: "ask-\(seq)")` via `UUID(uuidHashOf:)`-style deterministic construction: use `UUID(uuidString: String(format:…))`? Simplest deterministic: store `metadata.seq` and key `expandedTurns` off it — but `Identifiable` needs `id`: compute `let id = UUID()` per load is unstable → use `Identifiable` conformance on a wrapper with `id = seq`. DECISION: `LlmChatSheet` maps items to `ChatMessage` with `id: UUID` from `UUID(uuidString: "00000000-0000-0000-0000-\(String(format: "%012d", seq))")!` — deterministic, collision-free within the transcript, stable across reloads.)

- [ ] **Step 1: Failing tests:** AgentAskTransport calls through with history mapping (script `askAgent` via a protocol double — introduce `protocol AgentAskSending { func askAgent(...) }` in the transport file, `LlmIdeAPIClient` conforms in an extension; the double returns a canned reply); LlmChatSheet engine wiring is view-level — assert instead via a small `LlmChatViewModel` extracted from the sheet holding `send()`, `stop()`, `loadHistory()` (test the view model, not the View).
- [ ] **Step 2: FAIL → Step 3: implement** transport + view model + sheet rewire. Markdown: assistant bubbles `SelfSizingMarkdownView(markdown: msg.content, isDark: theme.current.isDark) { _ in }` with no height caching (sheet scrolls natively).
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `feat(mac): llm-chat on the chat engine — markdown + Stop`

---

### Task 12: Engine registry + mobile `explore_chat` on the engine

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/ChatEngineRegistry.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` (`handleExploreChat` 637-739), `CodeAssistantPanel.swift` (resolve engine from registry)
- Test: `mac/Tests/LlmIdeMacTests/ChatEngineRegistryTests.swift`

**Interfaces:**
- Produces:

```swift
@MainActor @Observable
final class ChatEngineRegistry {
    static let shared = ChatEngineRegistry()
    private var engines: [ChatScope: ChatEngine] = [:]
    func engine(for scope: ChatScope, api: LlmIdeAPIClient) -> ChatEngine  // lazily creates + wires default hooks
}
extension ChatEngine {
    /// One turn driven by a non-view client (iPhone). Streams progress via
    /// callbacks, persists through the engine's normal path, returns the reply.
    func runExternalTurn(message: String, skillIds: [String],
                         attachments: [LlmIdeAPIClient.CodeAttachment],
                         agentContext: AgentContext?,
                         model: String?, provider: String?,
                         onProgress: @escaping (String) -> Void) async throws -> String
}
```

- [ ] **Step 1: Failing tests:** (a) registry returns the SAME instance for a scope across calls; (b) `runExternalTurn` appends user+assistant messages, persists (store override dir), invokes `onProgress` per scripted progress step, and — when the panel shares the instance — `engine.messages` already contains the turn (no disk reload needed).
- [ ] **Step 2: FAIL → Step 3: implement.** Panel: replace its private engine with `ChatEngineRegistry.shared.engine(for: scope, api: api)` and re-wire env hooks on appear (registry keeps weak hook refs; hooks are re-asserted idempotently). MobileControlManager: `handleExploreChat` becomes resolve-engine → build input (existing MobileExploreBridge code, lines 658-678 stays) → `runExternalTurn` → send phone `Output`. The two direct `ChatSessionStore.load/append/save` blocks (683-688, 724-728) are DELETED (engine persists). The pre-flight session-existence guard (646-657) becomes `engine.sessionExists(id:)`. `.explorerChatTranscriptChanged` posting stays (other surfaces listen), but the panel's own onReceive reload (panel lines 278-290) is deleted — it observes the shared engine directly. Panel `handleOnAppear` must NOT mint a fresh session if the registry engine already has one loaded (idempotency guard: `if engine.currentSessionIDString.isEmpty`).
- [ ] **Step 4: PASS + full suite; verify with the loopback script `scripts/mobile/verify-native-pairing.swift` if runnable headless, else note manual check → Step 5: Commit** `refactor(mac): shared per-scope engines; explore_chat drives the explorer engine`

---

### Task 13: Actor-isolated, debounced persistence

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift` → move to `mac/Sources/LlmIdeMac/Chat/ChatSessionStore.swift` as `actor ChatSessionStoreActor` (keep a deprecated `enum ChatSessionStore` shim delegating synchronously for any straggler call sites, deleted same task after grep proves zero users), `ChatEngine.swift`, `CodeAssistantPanel.swift` (willTerminate)
- Test: `mac/Tests/LlmIdeMacTests/ChatSessionStoreActorTests.swift`

**Interfaces:**
- Produces:

```swift
actor ChatSessionStoreActor {
    static let shared = ChatSessionStoreActor()
    init(baseDirectory: URL? = nil)   // test override
    func list(for scope: ChatScope) -> [ChatSession]
    func load(id: UUID) -> ChatSession?
    /// Debounced ~500ms; atomic write; bumps lastUsedAt once per flush.
    func save(_ session: ChatSession)
    func flush()                // write any pending save NOW (switch/delete/terminate)
    func delete(id: UUID); func clear(for scope:); func clear()
}
```

- [ ] **Step 1: Failing tests:** (a) three rapid `save` calls with different content → after `flush()`, disk holds the LAST content and file-write count (observable via directory mtime sampling in a temp dir is flaky — instead expose `private(set) nonisolated var writeCount` guarded by a lock, or return a count from `flush()`) is ≤ 2 (debounce coalesced); (b) `flush()` after `delete` performs NO dangling write (cancel pending save when deleted); (c) decode-failure still quarantines (`.corrupt-*` file appears in temp dir).
- [ ] **Step 2: FAIL → Step 3: implement.** Debounce INSIDE the actor: `save` stores `pending[session.id] = session` and (re)schedules a `Task.sleep(nanoseconds: 500_000_000)` keyed by id; `flush()` cancels timers and writes all pending synchronously. Engine call sites become `Task { await ChatSessionStoreActor.shared.save(...) }`; `switchSession`/`deleteSession`/`createNewSession` `await …flush()` first (they're already async or made so). Panel adds `.onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in Task { await ChatSessionStoreActor.shared.flush() } }`. Quarantine/migration/legacy logic copies over unchanged (including `baseDirectoryOverride` semantics via init parameter).
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `refactor(mac): actor-isolated debounced chat session persistence`

---

### Task 14: Full history + draft/queue persistence

**Files:**
- Modify: `ChatMessage.swift` (ChatSession fields), `ChatEngine.swift`, `ChatSessionStoreActor` callers
- Test: `mac/Tests/LlmIdeMacTests/ChatPersistenceCompletenessTests.swift`

**Interfaces:**
- Consumes: v2 envelope from Task 8.
- Produces: `ChatSession` gains `draft: String?` and `pendingQueue: [ChatEngine.QueuedMessage]?` (Codable, default nil — decoder tolerant). Engine: `persistCurrentChat` drops `suffix(50)` (persist ALL messages; the cap existed only for file size — the wire budget in `historyForRequest` remains the only limiter); engine owns `draft` (`var draft: String` with didSet → schedules save; panel binds `$engine.draft` and DELETES its own `@State draft`); queue changes schedule a save.

- [ ] **Step 1: Failing tests:** (a) 120-message history persists to 120 messages on disk after flush (old behavior: 50); (b) set `engine.draft = "half-typed"`, `engine.enqueue("next")`, flush, `engine.reloadCurrentFromDisk()` → draft and queue restored; (c) queue drain after restore sends the queued message when a new turn runs.
- [ ] **Step 2: FAIL → Step 3: implement.** `resetTransientSessionState` clears draft+queue ONLY when switching sessions — after a switch, restored values come from the newly loaded session (adjust: `switchSession` sets `draft = session.draft ?? ""`, `queued = session.pendingQueue ?? []`). `rebuildSentPrompts` unaffected (reads messages).
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `fix(mac): no silent chat data loss — full history, drafts, queue persist`

---

### Task 15: Streaming render coalescing + single markdown path

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Chat/ChatEngine.swift`, `mac/Sources/LlmIdeMac/Views/Library/MarkdownRenderer.swift` → move to `Chat/ChatMarkdownRenderer.swift` (+ add `static func plainText(markdown: String) -> String`), `ChatMessageList.swift`, `SelfSizingMarkdownView.swift`, `LlmChatSheet.swift`
- Test: `mac/Tests/LlmIdeMacTests/ChatStreamCoalescingTests.swift`, `mac/Tests/LlmIdeMacTests/ChatMarkdownRendererTests.swift`

**Interfaces:**
- Produces: engine `var chunkFlushIntervalNanos: UInt64 = 100_000_000` (test-injectable) + `private(set) var streamAppendCount = 0` (test observer); `ChatMarkdownRenderer.html(markdown:isDark:)` (existing `MarkdownRenderer.html` renamed) and `ChatMarkdownRenderer.plainText(markdown:)` (replaces `ChatMessageList.markdownPreview`, rules copied verbatim: link-text unwrap, structural-char strip, whitespace collapse, 160-char ellipsis).

- [ ] **Step 1: Failing tests:** (a) feed 1000 chunks with flush interval 0 → `streamAppendCount` increments ≤ (chunks × interval-based bound): with interval 0 and immediate `Task.yield`, assert the FINAL content is complete and, with interval 50ms and 1000 instant chunks, `streamAppendCount` ≤ 5; (b) `plainText` matches the old `markdownPreview` output on 6 sample markdowns (headings, links, code fence, bold, list, table row) — port as golden tests BEFORE deleting the old function.
- [ ] **Step 2: FAIL → Step 3: implement.** Engine buffers chunks in `pendingChunkText`; a scheduled flush task publishes at most one history mutation per interval; `finishStreamingTurn` flushes remainder immediately. ChatMessageList: while `msg.status == .streaming`, render `Text(displayed)` (monospaced-ish plain, same styling as collapsed preview) instead of `SelfSizingMarkdownView`; on `.done`, the existing expanded markdown path renders ONCE. Move/rename MarkdownRenderer; replace `markdownPreview` call with `ChatMarkdownRenderer.plainText`; delete the regex copy. `SelfSizingMarkdownView` keeps its height callback; bubbleHeights cache now only matters for finalized turns.
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `perf(mac): coalesced streaming + single markdown path`

---

### Task 16: Failure UX — Retry + offline banner

**Files:**
- Modify: `ChatEngine.swift`, `ChatMessageList.swift` (delete `errorBubble`, add per-message failed row), `ChatSessionHeader.swift` (offline chip)
- Test: `mac/Tests/LlmIdeMacTests/ChatRetryTests.swift`

**Interfaces:**
- Produces: `extension ChatEngine { func retry(_ messageID: UUID) async }` — validates the message is `.failed` with `retryPayload`, resets it to `.streaming` (fresh placeholder semantics: re-run the original send), clears `failedError`. `ChatEngine.offline: Bool` (panel sets from `backend.status != .running`; engine disables `enqueue/startTurn` while offline, error message "Server offline — reconnecting…"). `ChatMessageList` renders a `.failed` message with a bordered danger row: error text + `Retry` button → `engine.retry(msg.id)`; the global `error` bubble + `@Binding error` are deleted (engine keeps `error` only for non-message failures like auto-chain refusals — rendered as a transient banner in the header area, dismiss-only).

- [ ] **Step 1: Failing tests:** (a) failed send → message `.failed`, `failedError` set, engine error nil; `retry(id)` → transport receives the ORIGINAL message text + skills again, message ends `.done`; (b) `enqueue` while `offline == true` records nothing and `error` mentions offline; (c) stop mid-stream still yields `.stopped` (regression guard — no Retry shown for stopped).
- [ ] **Step 2: FAIL → Step 3: implement.** `runTurn`'s catch (engine version): on non-cancellation failure, if the streaming placeholder has empty content and no chunks arrived, mark THAT message `.failed` with `retryPayload` (message, skillIds) instead of the global error; if partial content exists, keep `.stopped`-style finalization + header banner. Panel: header shows an offline dot + "Reconnecting…" when `backend.status != .running` (observe `@Environment(BackendManager.self)` — panel gains `@Environment(BackendManager.self) private var backend` and `.onChange(of: backend.status) { engine.offline = $0 != .running }`).
- [ ] **Step 4: PASS + full suite → Step 5: Commit** `feat(mac): per-message failure retry + chat offline state`

---

### Task 17: Docs + final gates

**Files:**
- Modify: `docs/spec/macos-app.md` (chat sections: engine architecture, session file v2, Retry/Stop/offline semantics, registry), `docs/explanation/invariants.md` (add/adjust the Code Assistant panel invariants that changed: `"("` convention → toolResult role; 50-cap → full history; per-chunk reload → coalesced), `CLAUDE.md` only if the "Where to Add X" table references moved files.
- Test: none new — verification task.

- [ ] **Step 1:** Update the two docs above; keep statements rebuild-grade (`docs/spec/` style: exact file paths + line-stable descriptions).
- [ ] **Step 2:** Run `make docs-check` → PASS (drift-guards).
- [ ] **Step 3:** Run `make test-mac` → all green; run `make regression` → green (pre-push gate; swift build+test runs here — pre-warm `.build` once, push ONCE per `memory/push-hook-build-gate.md`).
- [ ] **Step 4:** Manual smoke on the real app (`swift build && open mac/.build/debug/LlmIdeMac.app` — GUI interaction needs Accessibility permission): send a turn, stop mid-stream, queue a message during a turn, switch sessions mid-stream, kill/relaunch (draft survives), delete the active chat. Note results in the commit body.
- [ ] **Step 5: Commit** `docs: chat refactor — engine architecture, session v2, failure UX`

---

## Self-Review (completed during planning)

1. **Spec coverage:** engine extraction (T4-7), transport seam + fallback rule (T3), model v2 + migration incl. ack/bash/stopped conversion (T8-10), surface unification llm-chat + mobile (T11-12), actor persistence + full history + drafts/queue (T13-14), coalescing + single markdown (T15), Retry + offline (T16), docs/drift-guards (T17). Spec's "bubbleHeights/turnModes leak" dies structurally in T9 (dicts deleted). Spec's "deleted `suffix(50)`" in T14. Characterization-before-move satisfied via Phase 1 pure seams + failing-first engine tests (deviation documented in Global Constraints).
2. **Placeholders:** Task 5's table rows carry comment stubs with exact expected outcomes; each executor MUST replace them with real `PendingTool` fixtures per `AgentTypes.swift:137` before running — flagged in-task. No other TBDs.
3. **Type consistency:** `ChatTransportInput/Result`, `ChatEngine` API, `ChatMessage` fields, `ChatSessionStoreActor`, `ChatEngineRegistry` names are used identically in later tasks; `history` → `messages` rename sequenced T8 (session) then T9 (engine) with the `wireTurn()` bridge between.
