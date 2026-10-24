import Testing
import Foundation
@testable import LlmIdeMacLib

/// An app-initiated stop (the background-chat limit sweep) leaves a visible
/// reason in the stopped turn; a plain user stop does not.
@MainActor
@Suite("ChatEngine stop notice")
struct ChatEngineStopNoticeTests {
    private func engineWithStreamingTurn() -> (ChatEngine, UUID) {
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        let msg = ChatMessage(role: .assistant, content: "partial", status: .streaming, createdAt: Date())
        engine.messages.append(msg)
        return (engine, msg.id)
    }

    @Test("stopRunning(reason:) is recorded in the stopped turn")
    func reasonAppended() {
        let (engine, id) = engineWithStreamingTurn()
        engine.stopRunning(reason: ChatEngineRegistry.backgroundLimitStopNotice)
        engine.finishStreamingTurn(id, pendingTool: nil, tasks: nil, continueNeeded: nil,
                                   usage: nil, mode: nil, stopped: true)
        let m = engine.messages.first { $0.id == id }
        #expect(m?.status == .stopped)
        #expect(m?.content.contains("Stopped: too many chats running in the background (limit 6).") == true)
        #expect(engine.pendingStopNotice == nil)
    }

    @Test("a plain stop adds no notice")
    func plainStop() {
        let (engine, id) = engineWithStreamingTurn()
        engine.stop()
        engine.finishStreamingTurn(id, pendingTool: nil, tasks: nil, continueNeeded: nil,
                                   usage: nil, mode: nil, stopped: true)
        #expect(engine.messages.first { $0.id == id }?.content == "partial")
    }
}
