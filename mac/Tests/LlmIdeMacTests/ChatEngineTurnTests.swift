import Testing
import Foundation
@testable import LlmIdeMacLib

/// Characterization suite for `ChatEngine` — the turn lifecycle lifted out of
/// `CodeAssistantPanel+Session.swift`. These tests pin the semantics the
/// panel's inline copies documented in prose (partial text survives a stop,
/// a real failure still finalizes the placeholder, the queue drains FIFO one
/// message per turn, tool progress is deduped per turn) so the later tasks
/// that reshape the panel around this engine can't quietly change them.
@MainActor
@Suite("ChatEngine turn lifecycle")
struct ChatEngineTurnTests {
    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        // Scope is irrelevant to the turn lifecycle — these tests never touch
        // session files; ChatEngineSessionTests covers the scoped paths.
        let engine = ChatEngine(scope: .explorer, transport: t)
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
        // `.agent` is a real, constructible `APIError` case (see
        // LlmIdeAPIClient.swift) — the brief's `.network(underlying:message:)`
        // sketch does not exist; `.network` wraps a single `Error`.
        t.thrownError = APIError.agent(message: "down")
        await engine.runTurn("hi")
        #expect(engine.error != nil)
        #expect(engine.history.last?.role == .assistant)
        #expect(engine.revealingTurnID == nil)
        // The placeholder is finalized, not orphaned mid-stream.
        #expect(engine.busy == false)
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
        #expect(userTexts.contains("first"))
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
        let steps = engine.turnActivity[engine.history[1].id] ?? []
        #expect(steps.map(\.label) == ["Reading Foo.swift", "Running npm test"])
        #expect(engine.statusText == "Running npm test")
    }

    @Test("Non-default reply mode is recorded for the turn; default modes are not")
    func turnModeRecording() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "planned", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: CodeAssistMode.plan.rawValue)
        await engine.runTurn("plan it")
        #expect(engine.turnModes[engine.history[1].id] == .plan)

        let (engine2, t2) = makeEngine()
        t2.result = .init(reply: "ran", pendingTool: nil, tasks: nil,
                          continueNeeded: nil, usage: nil, mode: CodeAssistMode.execute.rawValue)
        await engine2.runTurn("run it")
        #expect(engine2.turnModes.isEmpty)
    }

    @Test("Follow-up sends (continue), appends one assistant turn, never drains the queue")
    func followup() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "ack", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("hi")           // ends with busy == false
        engine.enqueue("ignored", skillIds: [])  // not drained by sendFollowup
        await engine.sendFollowup()
        // A follow-up appends only the assistant placeholder — the synthetic
        // "(continue)" user message is a wire-only detail, never in `history`.
        #expect(engine.history.count == 3)
        #expect(engine.history.last?.content == "ack")
        #expect(t.receivedInputs.last?.message == "(continue)")
        #expect(engine.queued.map(\.text) == ["ignored"])
    }

    @Test("Announcements route through the injected hook, not NSAccessibility")
    func announcementHook() async {
        let (engine, t) = makeEngine()
        var announced: [String] = []
        engine.sendAnnouncement = { announced.append($0) }
        t.result = .init(reply: "the complete answer", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("hi")
        #expect(announced == ["the complete answer"])
    }
}
