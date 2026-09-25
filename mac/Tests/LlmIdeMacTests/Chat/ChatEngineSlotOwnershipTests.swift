import Testing
import Foundation
@testable import LlmIdeMacLib

/// Holds every round trip until `release(n)`; returns an empty reply after.
/// Ignores cancellation on purpose — a real transport unwinds some time
/// after a reset cancels it, which is the window this suite is about.
@MainActor
final class GatedChatTransport: ChatTransport, @unchecked Sendable {
    private var gates: [CheckedContinuation<Void, Never>?] = []
    private var released: Set<Int> = []
    private(set) var started = 0

    func roundTrip(_ input: ChatTransportInput,
                   onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
                   onChunk: @escaping @MainActor (String) -> Void) async throws -> ChatTransportResult {
        let index = started
        started += 1
        gates.append(nil)
        if !released.contains(index) {
            await withCheckedContinuation { gates[index] = $0 }
        }
        return ChatTransportResult(reply: "done \(index)", pendingTool: nil, tasks: nil,
                                   continueNeeded: nil, usage: nil, mode: nil, tokenUsage: nil)
    }

    func release(_ index: Int) {
        released.insert(index)
        if index < gates.count, let g = gates[index] { gates[index] = nil; g.resume() }
    }
}

@MainActor
@Suite("ChatEngine turn-slot ownership", .serialized)
struct ChatEngineSlotOwnershipTests {

    private func waitUntil(_ cond: () -> Bool) async {
        for _ in 0..<2000 where !cond() { await Task.yield() }
    }

    /// F9 #2: a turn cancelled by a reset unwinds LATER and used to run
    /// `drainQueueOrRelease` unconditionally — clearing `busy`/`runTask` of
    /// the newer turn that had claimed the slot meanwhile.
    @Test("a reset turn's late tail leaves a newer turn's slot alone")
    func staleTailDoesNotReleaseNewerTurn() async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("slot-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer { ChatSessionStore.baseDirectoryOverride = nil; try? FileManager.default.removeItem(at: tmp) }

        let transport = GatedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: transport)
        engine.hooks.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }

        engine.startTurn("first")
        await waitUntil { transport.started == 1 }
        engine.resetActiveTurnState()          // e.g. a quick-chat project switch
        #expect(engine.busy == false)

        engine.startTurn("second")
        await waitUntil { transport.started == 2 }
        #expect(engine.busy)

        transport.release(0)                   // the cancelled first turn unwinds now
        for _ in 0..<200 { await Task.yield() }
        #expect(engine.busy, "the newer turn still owns the slot")
        #expect(engine.runTask != nil, "Stop can still reach the newer turn")

        transport.release(1)
        await waitUntil { !engine.busy }
        #expect(engine.busy == false, "the newer turn's own tail releases normally")
    }

    /// A plain Stop is not a reset: the stopped turn's tail is still the one
    /// that releases the slot.
    @Test("a stopped turn's tail still releases the slot")
    func stoppedTurnReleases() async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("slot-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer { ChatSessionStore.baseDirectoryOverride = nil; try? FileManager.default.removeItem(at: tmp) }

        let transport = GatedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: transport)
        engine.hooks.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        engine.startTurn("only")
        await waitUntil { transport.started == 1 }
        engine.runTask?.cancel()
        transport.release(0)
        await waitUntil { !engine.busy }
        #expect(engine.busy == false)
    }
}
