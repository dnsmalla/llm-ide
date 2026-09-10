import Testing
import Foundation
@testable import LlmIdeMacLib

/// Pins the streaming hot path's cost model.
///
/// The server emits one SSE `chunk` per model text delta — 5-20 characters —
/// so a normal reply arrives as a thousand-plus callbacks. Each one used to
/// mutate `messages` directly, and every mutation cost a SwiftUI invalidation,
/// a `WKWebView` document reload, and (through the panel's
/// `.onChange(of: engine.messages)`) a synchronous session-file read + atomic
/// write — all on the MainActor. `ChatEngine` now BATCHES chunks and DEBOUNCES
/// the session write.
///
/// These tests exist because that batching is invisible in the final result:
/// every existing turn-lifecycle test still sees the same finished text, which
/// is exactly the property that makes it safe — and exactly why a future
/// refactor could undo it without any of them noticing. They assert the
/// intermediate behaviour instead: how many times the array is written, and
/// that nothing is lost on the exit paths that don't overwrite from the
/// server's final reply.
@MainActor
@Suite("ChatEngine streaming cost model")
struct ChatEngineStreamingPerfTests {

    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: t)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        return (engine, t)
    }

    @Test("Chunks are buffered, not written per delta — the message stays empty until a flush")
    func chunksAreBuffered() {
        let (engine, _) = makeEngine()
        let id = engine.beginStreamingTurn()

        // A hundred deltas, as the wire delivers them.
        for i in 0..<100 { engine.appendStreamedChunk(id, "d\(i)") }

        // Nothing has been published yet: no coalescing window has elapsed,
        // so the transcript has seen ZERO writes for a hundred callbacks.
        // This is the whole point — assert it directly, not via the total.
        #expect(engine.messages.last?.content == "")
        #expect(engine.revealedCount == 0)

        engine.flushPendingChunks()

        // One write, carrying everything, in order.
        #expect(engine.messages.last?.content == (0..<100).map { "d\($0)" }.joined())
        #expect(engine.revealedCount == engine.messages.last?.content.count)
    }

    @Test("A flush is idempotent — calling it again writes nothing more")
    func flushIsIdempotent() {
        let (engine, _) = makeEngine()
        let id = engine.beginStreamingTurn()
        engine.appendStreamedChunk(id, "once")
        engine.flushPendingChunks()
        engine.flushPendingChunks()
        engine.flushPendingChunks()
        #expect(engine.messages.last?.content == "once")
    }

    @Test("Buffered text survives a stop — finishStreamingTurn flushes before finalizing")
    func stopFlushesBuffer() async {
        let (engine, t) = makeEngine()
        // A turn that streams and is then cancelled: the success path's
        // `resp.reply` overwrite never runs, so the ONLY thing that can save
        // this text is the flush inside finishStreamingTurn.
        t.scripted = [.chunk("partial "), .chunk("answer")]
        t.thrownError = CancellationError()
        await engine.runTurn("hi")
        #expect(engine.messages[1].content == "partial answer")
        #expect(engine.messages[1].status == .stopped)
    }

    @Test("Buffered text survives a real failure too, and the reason is attached")
    func failureFlushesBuffer() async {
        let (engine, t) = makeEngine()
        t.scripted = [.chunk("half an ")]
        t.thrownError = APIError.agent(message: "backend gave up")
        await engine.runTurn("hi")
        #expect(engine.messages[1].content == "half an ")
        #expect(engine.messages[1].status == .failed)
        #expect(engine.messages[1].metadata?.failedError != nil)
    }

    @Test("A chunk for a different turn lands the previous turn's buffer first")
    func turnBoundaryFlushes() {
        let (engine, _) = makeEngine()
        let first = engine.beginStreamingTurn()
        engine.appendStreamedChunk(first, "first turn text")
        // Without the boundary flush this text would either be lost or be
        // appended onto the SECOND turn.
        let second = engine.beginStreamingTurn()
        engine.appendStreamedChunk(second, "second")
        #expect(engine.messages[0].content == "first turn text")
        engine.flushPendingChunks()
        #expect(engine.messages[0].content == "first turn text")
        #expect(engine.messages[1].content == "second")
    }

    @Test("The success path discards the buffer — the final reply is not double-appended")
    func successPathDoesNotDuplicate() async {
        let (engine, t) = makeEngine()
        t.scripted = [.chunk("Hel"), .chunk("lo")]
        t.result = .init(reply: "Hello", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("hi")
        // If the buffer were FLUSHED rather than discarded before the
        // overwrite, a late flush could re-append "Hello" onto itself.
        #expect(engine.messages[1].content == "Hello")
    }

    @Test("The coalescing timer publishes on its own, without an explicit flush")
    func timerPublishes() async throws {
        let (engine, _) = makeEngine()
        engine.chunkCoalesceNanos = 1_000_000  // 1 ms, so the test doesn't wait
        let id = engine.beginStreamingTurn()
        engine.appendStreamedChunk(id, "tick")
        #expect(engine.messages.last?.content == "")
        try await Task.sleep(nanoseconds: 60_000_000)
        // The turn is still live (nothing finalized it) — the only thing that
        // can have written this is the coalescing task itself.
        #expect(engine.messages.last?.content == "tick")
    }

    @Test("discardPendingChunks drops buffered text and cancels the timer")
    func discardDropsBuffer() async throws {
        let (engine, _) = makeEngine()
        engine.chunkCoalesceNanos = 1_000_000
        let id = engine.beginStreamingTurn()
        engine.appendStreamedChunk(id, "unwanted")
        engine.discardPendingChunks()
        try await Task.sleep(nanoseconds: 60_000_000)
        // Neither the explicit discard nor the pending timer may write it.
        #expect(engine.messages.last?.content == "")
    }
}

/// Pins the retry affordance on a failed turn.
///
/// `markFailed` has always recorded `.failed` plus `metadata.failedError`, but
/// nothing read either: a failed reply rendered as an empty bubble behind a
/// dismissible banner, with no way to re-send short of retyping. These tests
/// pin both halves of the fix — which turns is offered a Retry, and what
/// re-sending actually does to the transcript.
@MainActor
@Suite("ChatEngine failed-turn retry")
struct ChatEngineRetryTests {

    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: t)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        return (engine, t)
    }

    @Test("A failed user turn is retryable; a stopped or successful one is not")
    func retryabilityByStatus() async {
        let (engine, t) = makeEngine()
        t.thrownError = APIError.agent(message: "nope")
        await engine.runTurn("do the thing")
        let failedID = engine.messages[1].id
        #expect(engine.canRetryFailedTurn(failedID) == true)

        // A user-initiated stop is not a failure — offering Retry there would
        // mean re-running work the user deliberately cancelled.
        let (engine2, t2) = makeEngine()
        t2.thrownError = CancellationError()
        await engine2.runTurn("stop me")
        #expect(engine2.canRetryFailedTurn(engine2.messages[1].id) == false)
    }

    @Test("A failed FOLLOW-UP is not retryable — it has no user turn of its own")
    func followupNotRetryable() async {
        let (engine, t) = makeEngine()
        // Land a user turn + reply first, so the follow-up's placeholder is
        // preceded by an assistant turn rather than a user one.
        t.result = .init(reply: "ok", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        await engine.runTurn("first")
        t.thrownError = APIError.agent(message: "follow-up failed")
        await engine.sendFollowup()
        let last = engine.messages[engine.messages.count - 1]
        #expect(last.status == .failed)
        // Re-sending would mean re-driving a tool chain, not re-asking a
        // question — so no button is offered.
        #expect(engine.canRetryFailedTurn(last.id) == false)
    }

    @Test("Retry removes the failed pair and re-sends the prompt, leaving no duplicate")
    func retryReplacesFailedPair() async {
        let (engine, t) = makeEngine()
        t.thrownError = APIError.agent(message: "transient")
        await engine.runTurn("summarize the repo")
        #expect(engine.messages.count == 2)
        #expect(engine.error != nil)

        t.thrownError = nil
        t.result = .init(reply: "Here you go.", pendingTool: nil, tasks: nil,
                         continueNeeded: nil, usage: nil, mode: nil)
        engine.retryFailedTurn(engine.messages[1].id)
        await engine.runTask?.value

        // Exactly one user turn and one reply — not a second copy of the
        // prompt stacked under the failed one.
        #expect(engine.messages.map(\.role) == [.user, .assistant])
        #expect(engine.messages[0].content == "summarize the repo")
        #expect(engine.messages[1].content == "Here you go.")
        #expect(engine.messages[1].status == .done)
        // The banner described the failure that was just retried.
        #expect(engine.error == nil)
    }

    @Test("Retry is refused while another turn is running")
    func retryRefusedWhileBusy() async {
        let (engine, t) = makeEngine()
        t.thrownError = APIError.agent(message: "transient")
        await engine.runTurn("hi")
        let failedID = engine.messages[1].id
        engine.busy = true
        engine.retryFailedTurn(failedID)
        // Untouched: the failed turn is still there, nothing was re-sent.
        #expect(engine.messages.count == 2)
        #expect(engine.messages[1].id == failedID)
    }
}
