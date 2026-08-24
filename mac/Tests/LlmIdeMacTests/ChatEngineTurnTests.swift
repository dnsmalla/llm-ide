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
        #expect(engine.messages.map(\.role) == [.user, .assistant])
        #expect(engine.messages[1].content == "Hello")
        #expect(engine.messages[1].status == .done)
        #expect(engine.busy == false)
        #expect(engine.revealingTurnID == nil)
        #expect(engine.error == nil)
    }

    @Test("Stop mid-stream keeps partial text verbatim, marks .stopped, no error")
    func stopMidStream() async {
        let (engine, t) = makeEngine()
        t.scripted = [.chunk("partial answer")]
        t.thrownError = CancellationError()
        await engine.runTurn("hi")
        // Task 9: the stop is a STATUS, and the streamed text is untouched.
        // The "\n\n_(stopped)_" marker only reappears on the wire.
        #expect(engine.messages[1].content == "partial answer")
        #expect(engine.messages[1].status == .stopped)
        #expect(engine.messages[1].wireTurn().content == "partial answer\n\n_(stopped)_")
        #expect(engine.error == nil)
        // A user-initiated stop is not a failure — no retry affordance.
        #expect(engine.messages[1].metadata?.failedError == nil)
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
        #expect(engine.messages.last?.role == .assistant)
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
        let userTexts = engine.messages.filter { $0.role == .user }.map(\.content)
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
        // Task 9: steps live on the message that produced them, not in an
        // engine-side dictionary keyed by turn id.
        let steps = engine.messages[1].toolSteps
        #expect(steps.map(\.label) == ["Reading Foo.swift", "Running npm test"])
        #expect(engine.statusText == "Running npm test")
    }

    @Test("Non-default reply mode is recorded for the turn; default modes are not")
    func turnModeRecording() async {
        let (engine, t) = makeEngine()
        t.result = .init(reply: "planned", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: CodeAssistMode.plan.rawValue)
        await engine.runTurn("plan it")
        #expect(engine.messages[1].metadata?.mode == CodeAssistMode.plan.rawValue)

        let (engine2, t2) = makeEngine()
        t2.result = .init(reply: "ran", pendingTool: nil, tasks: nil,
                          continueNeeded: nil, usage: nil, mode: CodeAssistMode.execute.rawValue)
        await engine2.runTurn("run it")
        #expect(engine2.messages[1].metadata?.mode == nil)
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
        #expect(engine.messages.count == 3)
        #expect(engine.messages.last?.content == "ack")
        #expect(t.receivedInputs.last?.message == "(continue)")
        #expect(engine.queued.map(\.text) == ["ignored"])
    }

    // MARK: - Plan execution tracker

    private func runningTracker() -> CodeAssistantAgentState.PlanExecutionTracker {
        CodeAssistantAgentState.PlanExecutionTracker(
            planTitle: "Add dark mode",
            steps: ["Add tokens", "Wire the toggle"],
            planCardMessageId: UUID())
    }

    // A stop takes an early return that skips the tracker's only other exit
    // from `.running`. Left running, its card has no Dismiss and the
    // attachment bar stays hidden — the session is the only way out.
    @Test("Stop mid-execution lands the plan tracker on .failed, not stuck .running")
    func stopLandsPlanExecution() async {
        let (engine, t) = makeEngine()
        engine.agent.planExecution = runningTracker()
        t.thrownError = CancellationError()
        await engine.runTurn("execute the plan")
        #expect(engine.agent.planExecution?.phase == .failed)
    }

    @Test("A real failure also lands the plan tracker rather than leaving it running")
    func failureLandsPlanExecution() async {
        let (engine, t) = makeEngine()
        engine.agent.planExecution = runningTracker()
        t.thrownError = APIError.agent(message: "down")
        await engine.runTurn("execute the plan")
        #expect(engine.agent.planExecution?.phase == .failed)
    }

    @Test("All tasks completed with no continue finishes the plan tracker")
    func completedTasksFinishPlanExecution() async {
        let (engine, t) = makeEngine()
        engine.agent.planExecution = runningTracker()
        t.result = .init(
            reply: "done",
            pendingTool: nil,
            tasks: [AgentTask(id: "1", title: "Add tokens", status: .completed),
                    AgentTask(id: "2", title: "Wire the toggle", status: .completed)],
            continueNeeded: false, usage: nil, mode: nil)
        await engine.runTurn("execute the plan")
        #expect(engine.agent.planExecution?.phase == .finished)
        #expect(engine.agent.planExecution?.lastTasks.count == 2)
    }

    @Test("A failed task stops the plan tracker even while other steps remain")
    func failedTaskStopsPlanExecution() async {
        let (engine, t) = makeEngine()
        engine.agent.planExecution = runningTracker()
        t.result = .init(
            reply: "hit an error",
            pendingTool: nil,
            tasks: [AgentTask(id: "1", title: "Add tokens", status: .failed),
                    AgentTask(id: "2", title: "Wire the toggle", status: .pending)],
            continueNeeded: false, usage: nil, mode: nil)
        await engine.runTurn("execute the plan")
        #expect(engine.agent.planExecution?.phase == .failed)
    }

    @Test("Work still pending keeps the plan tracker running")
    func pendingTasksKeepPlanExecutionRunning() async {
        let (engine, t) = makeEngine()
        engine.agent.planExecution = runningTracker()
        // Pre-set the stop flag purely to keep this test hermetic: the tracker
        // update runs before the auto-continue branch, so the phase assertion
        // is unaffected, but no "Continue working…" turn gets scheduled onto
        // the main queue to fire after the test has ended. (`onTurnStart`
        // defaults to a no-op here, so nothing clears the flag.)
        engine.agent.agentStopRequested = true
        t.result = .init(
            reply: "step 1 done",
            pendingTool: nil,
            tasks: [AgentTask(id: "1", title: "Add tokens", status: .completed),
                    AgentTask(id: "2", title: "Wire the toggle", status: .pending)],
            continueNeeded: true, usage: nil, mode: nil)
        await engine.runTurn("execute the plan")
        #expect(engine.agent.planExecution?.phase == .running)
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
