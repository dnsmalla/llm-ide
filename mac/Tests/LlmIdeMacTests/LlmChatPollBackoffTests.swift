import Testing
import Foundation
@testable import LlmIdeMacLib

/// Pins the shared-transcript poll's cost model.
///
/// `LlmChatSheet` and `MenuBarChatView` refetched the whole shared transcript
/// every 2 seconds for as long as they were open. The rate was never what kept
/// them in sync — every in-process change already posts
/// `.llmChatTranscriptChanged` — so the poll now backs off geometrically while
/// nothing is happening and snaps back to the floor when something does.
@MainActor
@Suite("LLM Chat shared-transcript polling")
struct LlmChatPollBackoffTests {

    typealias Backoff = LlmChatViewModel.PollBackoff

    func makeViewModel() -> (LlmChatViewModel, ScriptedHistoryFetcher) {
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        let history = ScriptedHistoryFetcher()
        return (LlmChatViewModel(engine: engine, historyAPI: history), history)
    }

    func historyItem(seq: Int, role: String, content: String) -> LlmIdeAPIClient.AgentAskHistoryItem {
        .init(seq: seq, role: role, content: content, createdAt: 0)
    }

    @Test("An idle window backs off to the ceiling instead of polling forever at 2s")
    func backoffClimbsToCeiling() {
        var b = Backoff()
        #expect(b.seconds == Backoff.floor)
        // Geometric, so a window nobody is using settles quickly rather than
        // creeping there over hundreds of requests.
        var observed: [Double] = []
        for _ in 0..<8 { b.advance(); observed.append(b.seconds) }
        #expect(observed == [4, 8, 16, 30, 30, 30, 30, 30])
        #expect(b.seconds == Backoff.ceiling)
    }

    @Test("Activity snaps the interval back to the floor")
    func resetReturnsToFloor() {
        var b = Backoff()
        for _ in 0..<5 { b.advance() }
        #expect(b.seconds == Backoff.ceiling)
        b.reset()
        // The point of the reset: an active conversation polls exactly as
        // responsively as it did before the backoff existed.
        #expect(b.seconds == Backoff.floor)
    }

    @Test("loadHistory reports whether the transcript actually changed")
    func loadHistoryReportsChange() async {
        let (vm, history) = makeViewModel()
        history.items = [historyItem(seq: 1, role: "user", content: "hi"),
                         historyItem(seq: 2, role: "assistant", content: "hello")]

        // First load brings rows in — that's a change.
        #expect(await vm.loadHistory() == true)
        #expect(vm.engine.messages.count == 2)

        // Second load returns the identical transcript. This is the case that
        // dominates in practice, and the one the backoff is built on: if it
        // reported `true` the interval would never grow.
        #expect(await vm.loadHistory() == false)

        // New row from elsewhere (the iPhone) — a change again.
        history.items.append(historyItem(seq: 3, role: "user", content: "from the phone"))
        #expect(await vm.loadHistory() == true)
    }

    @Test("A turn in flight is not polled over, and reports no change")
    func busyEngineIsNotPolled() async {
        let (vm, history) = makeViewModel()
        history.items = [historyItem(seq: 1, role: "user", content: "hi")]
        vm.engine.busy = true
        #expect(await vm.loadHistory() == false)
        // Not merely unchanged — never fetched. Polling underneath a live
        // turn would race the engine's own writes.
        #expect(history.listCallCount == 0)
    }

    @Test("resetPollBackoff is reachable from the views' notification handler")
    func resetIsExposed() {
        let (vm, _) = makeViewModel()
        vm.resetPollBackoff()
        #expect(vm.pollBackoff.seconds == Backoff.floor)
    }
}
