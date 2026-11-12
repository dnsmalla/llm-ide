import Testing
import Foundation
@testable import SharedProtocol

private func enc<T: Encodable>(_ v: T) -> Data { try! JSONEncoder().encode(v) }
private func settle() async {
    for _ in 0..<50 { await Task.yield() }
    // resume finalization schedules the history snapshot on a detached Task; give it a real hop.
    try? await Task.sleep(nanoseconds: 50_000_000)
}

/// Streaming replies and resume-after-reconnect (`chat.delta` increments, `chat.resume`).
@MainActor
@Suite("Chat resume", .serialized)
struct ChatResumeTests {
    let ctx = FakeContext()

    private func reply(resume: @escaping () throws -> HostApiChatResumeResult) {
        ctx.scripted.reply = { cmd, _ in
            switch cmd {
            case .chatSend: return enc(HostApiChatSendResult(accepted: true))
            case .chatResume: return enc(try resume())
            case .chatSnapshot:
                return enc(HostApiChatSnapshotResult(messages: [.init(content: "hi", role: "user"), .init(content: "From history", role: "assistant")]))
            default: return Data("{}".utf8)
            }
        }
    }

    /// A store with one turn sent and `partial` streamed, then the connection dropped.
    private func detached(partial: String = "Hel") async -> (LlmIdeChatStore, String) {
        let store = LlmIdeChatStore(context: ctx)
        _ = await store.sendLlmideChat("hi")
        await settle()
        let id = ctx.scripted.calls[0].id!
        store.handle(.event(.chatDelta, payload: enc(HostApiChatDeltaEvent(text: partial)), replyTo: id))
        store.connectionDropped()
        return (store, id)
    }

    @Test("incremental deltas append in order")
    func incremental() async {
        reply { .init(state: "unknown") }
        let store = LlmIdeChatStore(context: ctx)
        _ = await store.sendLlmideChat("hi")
        await settle()
        let id = ctx.scripted.calls[0].id!
        for piece in ["a", "b", "c"] { store.handle(.event(.chatDelta, payload: enc(HostApiChatDeltaEvent(text: piece)), replyTo: id)) }
        #expect(store.llmIdeMessages.last?.text == "abc")
    }

    @Test("a drop keeps the turn waiting, not failed")
    func dropKeepsTurn() async {
        reply { .init(state: "unknown") }
        let (store, _) = await detached()
        #expect(store.isStreaming)
        #expect(store.isWaitingForDesktop)
        #expect(store.approvalNotice == LlmIdeChatStore.waitingNotice)
        #expect(store.llmIdeMessages.last?.text == "Hel")
    }

    @Test("resume running replaces the text, keeps listening, later deltas append")
    func resumeRunning() async {
        reply { .init(state: "running", text: "Hello wor", truncated: true) }
        let (store, id) = await detached()
        store.connectionReady()
        await settle()
        let sent = ctx.scripted.payload(ctx.scripted.calls(.chatResume)[0], as: HostApiChatResumeRequest.self)
        #expect(sent.requestId == id)
        #expect(sent.projectId == "p1")
        #expect(store.llmIdeMessages.last?.text == "Hello wor")
        #expect(store.isStreaming && !store.isWaitingForDesktop)
        #expect(store.approvalNotice == LlmIdeChatStore.truncatedNotice)
        store.handle(.event(.chatDelta, payload: enc(HostApiChatDeltaEvent(text: "ld")), replyTo: id))
        #expect(store.llmIdeMessages.last?.text == "Hello world")
        store.handle(.event(.chatDone, payload: enc(HostApiChatDoneEvent(requestId: id)), replyTo: nil))
        #expect(!store.isStreaming)
    }

    @Test("resume done finalizes with the host's text")
    func resumeDone() async {
        reply { .init(state: "done", text: "Final answer") }
        let (store, _) = await detached()
        store.connectionReady()
        await settle()
        #expect(!store.isStreaming && !store.isWaitingForDesktop)
        #expect(ctx.scripted.calls(.chatSnapshot).count == 1, "history reloads after the turn ends")
    }

    @Test("resume error ends the turn and shows the message")
    func resumeError() async {
        reply { .init(message: "Model overloaded", state: "error") }
        let (store, _) = await detached()
        store.connectionReady()
        await settle()
        #expect(!store.isStreaming && !store.isWaitingForDesktop)
        #expect(ctx.errorMessage == "Model overloaded")
    }

    @Test("resume unknown falls back to the snapshot")
    func resumeUnknown() async {
        reply { .init(state: "unknown") }
        let (store, _) = await detached()
        store.connectionReady()
        await settle()
        #expect(!store.isStreaming)
        #expect(store.llmIdeMessages.last?.text == "From history")
    }

    @Test("an old host's unknown_command falls back to the snapshot")
    func oldHost() async {
        reply { throw HostApiRejection(replyTo: nil, code: "unknown_command", message: "unknown") }
        let (store, _) = await detached()
        store.connectionReady()
        await settle()
        #expect(!store.isStreaming && !store.isWaitingForDesktop)
        #expect(store.llmIdeMessages.last?.text == "From history")
        #expect(ctx.errorMessage == nil)
    }

    @Test("a drop with no turn in flight behaves as before")
    func idleDrop() {
        let store = LlmIdeChatStore(context: ctx)
        store.connectionDropped()
        #expect(!store.isWaitingForDesktop)
        store.connectionReady()
        #expect(ctx.scripted.calls(.chatResume).isEmpty)
    }

    @Test("a re-sent approval prompt does not replace or duplicate the card")
    func noDuplicateApproval() async {
        reply { .init(state: "running", text: "x") }
        let store = LlmIdeChatStore(context: ctx)
        _ = await store.sendLlmideChat("hi")
        await settle()
        let id = ctx.scripted.calls[0].id!
        func prompt(_ question: String) -> Data {
            enc(HostApiApprovalRequestEvent(commandId: id, questions: [.init(multiSelect: false, options: [.init(label: "Yes")], question: question)], requestId: "r1"))
        }
        store.handle(.event(.approvalRequest, payload: prompt("First?"), replyTo: nil))
        store.handle(.event(.approvalRequest, payload: prompt("Second?"), replyTo: nil))
        #expect(store.pendingApproval?.questions.first?.question == "First?")
    }
}
