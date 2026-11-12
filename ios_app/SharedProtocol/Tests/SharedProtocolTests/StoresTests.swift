import Testing
import Foundation
@testable import SharedProtocol

/// A host that answers each command from a closure, so a test scripts the desktop's replies.
@MainActor
final class ScriptedHost: HostConnection {
    var apiVersion = 1
    var state: HostConnectionState = .connected
    var capabilities: Set<String> = ["host", "chat", "approvals", "read", "compose", "tool_approvals"]
    var onEvent: ((HostEvent) -> Void)?
    private(set) var calls: [(command: HostApiCommand, payload: Data, id: String?)] = []
    var reply: (HostApiCommand, Data) async throws -> Data = { _, _ in Data("{}".utf8) }

    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        calls.append((command, payload, id))
        return try await reply(command, payload)
    }
    func close() {}
    func payload<P: Decodable>(_ i: Int, as: P.Type) -> P { try! JSONDecoder().decode(P.self, from: calls[i].payload) }
    func calls(_ c: HostApiCommand) -> [Int] { calls.indices.filter { calls[$0].command == c } }
}

@MainActor
final class FakeContext: ChatHostContext {
    let scripted = ScriptedHost()
    var host: HostConnection { scripted }
    var isConnected = true
    var errorMessage: String?
    var selectedProjectId: String? = "p1"
    var sinks: [HostEventSink] = []
    var disconnected = false
    func scopedProjectId() async -> String? { selectedProjectId }
    func noteProjectRefusal(_ error: Error) -> Bool { false }
    func disconnect() { disconnected = true }
    func registerSink(_ sink: HostEventSink) { sinks.append(sink) }
}

private func enc<T: Encodable>(_ v: T) -> Data { try! JSONEncoder().encode(v) }
private func delta(_ text: String) -> Data { enc(HostApiChatDeltaEvent(text: text)) }
private func done(_ id: String) -> Data { enc(HostApiChatDoneEvent(requestId: id)) }
private func settle() async { for _ in 0..<50 { await Task.yield() } }

@MainActor
@Suite("Chat stores")
struct ChatStoreTests {
    let ctx = FakeContext()

    func ask() -> LlmIdeChatStore { LlmIdeChatStore(context: ctx) }
    func exec() -> ExecuteChatStore { ExecuteChatStore(context: ctx) }

    @Test("a store registers as an event sink")
    func registers() { _ = ask(); _ = exec(); #expect(ctx.sinks.count == 2) }

    @Test("the Execute store names its surface on send, snapshot, new and clear; the Ask store names none")
    func surfaces() async {
        ctx.scripted.reply = { cmd, _ in
            switch cmd {
            case .chatSend: return enc(HostApiChatSendResult(accepted: true))
            case .chatSnapshot: return enc(HostApiChatSnapshotResult(messages: []))
            case .chatNew: return enc(HostApiChatNewResult(sessionId: "s1"))
            default: return enc(HostApiChatHistoryClearResult(cleared: true))
            }
        }
        let e = exec(), a = ask()
        _ = await e.sendLlmideChat("run it", mode: "execute")
        _ = await a.sendLlmideChat("question")
        await settle()
        let sends = ctx.scripted.calls(.chatSend)
        #expect(ctx.scripted.payload(sends[0], as: HostApiChatSendRequest.self).surface == "execute")
        #expect(ctx.scripted.payload(sends[0], as: HostApiChatSendRequest.self).mode == "execute")
        #expect(ctx.scripted.payload(sends[1], as: HostApiChatSendRequest.self).surface == nil)
    }

    @Test("a streamed reply lands in the transcript; a foreign turn's delta is ignored")
    func streaming() async {
        ctx.scripted.reply = { _, _ in enc(HostApiChatSendResult(accepted: true)) }
        let a = ask(), e = exec()
        _ = await a.sendLlmideChat("hi")
        await settle()
        let id = ctx.scripted.calls[0].id!
        a.handle(.event(.chatDelta, payload: delta("Hel"), replyTo: id))
        a.handle(.event(.chatDelta, payload: delta("lo"), replyTo: id))
        e.handle(.event(.chatDelta, payload: delta("nope"), replyTo: id)) // the Execute store never started this turn
        #expect(a.llmIdeMessages.last?.text == "Hello")
        #expect(e.llmIdeMessages.isEmpty)
        #expect(a.isStreaming)
        ctx.scripted.reply = { cmd, _ in cmd == .chatSnapshot ? enc(HostApiChatSnapshotResult(messages: [.init(content: "hi", role: "user"), .init(content: "Hello", role: "assistant")])) : Data("{}".utf8) }
        a.handle(.event(.chatDone, payload: done(id), replyTo: nil))
        #expect(!a.isStreaming)
    }

    @Test("a reload that matches what streamed in keeps the local rows; a different one swaps them")
    func reloadReconciles() async {
        ctx.scripted.reply = { _, _ in enc(HostApiChatSendResult(accepted: true)) }
        let a = ask()
        _ = await a.sendLlmideChat("hi")
        await settle()
        let id = ctx.scripted.calls[0].id!
        a.handle(.event(.chatDelta, payload: delta("Hello"), replyTo: id))
        let before = a.llmIdeMessages.map(\.id)
        func snapshot(_ reply: String) -> (HostApiCommand, Data) async throws -> Data {
            { cmd, _ in cmd == .chatSnapshot ? enc(HostApiChatSnapshotResult(messages: [.init(content: "hi", role: "user"), .init(content: reply, role: "assistant")])) : Data("{}".utf8) }
        }
        ctx.scripted.reply = snapshot("Hello\n")           // same text, trailing newline
        a.handle(.event(.chatDone, payload: done(id), replyTo: nil))
        await settle()
        #expect(a.llmIdeMessages.map(\.id) == before, "unchanged transcript is not rebuilt")
        ctx.scripted.reply = snapshot("Hello there")        // the desktop stored something else
        a.loadSharedHistory()
        await settle()
        #expect(a.llmIdeMessages.last?.text == "Hello there")
    }

    @Test("clearing a chat the desktop refuses leaves the transcript on screen and says why")
    func clearRefused() async {
        let a = ask()
        a.llmIdeMessages = [ChatMessage(role: .user, text: "keep me")]
        ctx.scripted.reply = { _, _ in throw HostApiRejection(replyTo: nil, code: "denied", message: "Clearing the phone chat is turned off on this computer.") }
        a.clearLlmIdeChat()
        await settle()
        #expect(a.llmIdeMessages.count == 1)
        #expect(ctx.errorMessage == "Clearing the phone chat is turned off on this computer.")
    }

    @Test("clearing a chat the desktop confirms empties the transcript")
    func clearOk() async {
        let a = ask()
        a.llmIdeMessages = [ChatMessage(role: .user, text: "bye")]
        ctx.scripted.reply = { _, _ in enc(HostApiChatHistoryClearResult(cleared: true)) }
        a.clearLlmIdeChat()
        await settle()
        #expect(a.llmIdeMessages.isEmpty)
    }

    @Test("Stop frees the screen even when the desktop never answers the cancel")
    func stopAlwaysFrees() async {
        ctx.scripted.reply = { cmd, _ in
            cmd == .chatCancel ? enc(HostApiChatCancelResult(cancelled: true)) : enc(HostApiChatSendResult(accepted: true))
        }
        let e = exec()
        e.cancelGraceNanos = 10_000_000
        _ = await e.sendLlmideChat("long job", mode: "execute")
        await settle()
        #expect(e.isStreaming)
        e.cancelStreaming()
        for _ in 0..<500 where e.isStreaming { try? await Task.sleep(nanoseconds: 10_000_000) } // up to 5 s
        #expect(!e.isStreaming)
    }

    @Test("dropping the connection ends every turn and clears pending prompts")
    func dropEndsTurns() async {
        ctx.scripted.reply = { _, _ in enc(HostApiChatSendResult(accepted: true)) }
        let a = ask()
        _ = await a.sendLlmideChat("hi")
        await settle()
        #expect(a.isStreaming)
        a.handleChatError(commandId: nil)
        #expect(!a.isStreaming)
    }
}

@MainActor
@Suite("Loop and Tasks stores")
struct FeatureStoreTests {
    let ctx = FakeContext()

    @Test("loop refresh asks for the phone's runs and the desktop history of the project")
    func loopRefresh() async {
        ctx.scripted.reply = { cmd, _ in
            cmd == .loopList
                ? enc(HostApiLoopListResult(runs: [.init(createdAt: "2026-11-12T00:00:00Z", id: "cmd-0001", issueCount: 2, state: "running", step: "stage: Review")]))
                : enc(HostApiLoopHistoryResult(runs: [.init(id: "r1", loopName: "Regression", startedAt: "2026-11-11T00:00:00Z", statusCode: "success")]))
        }
        let s = LoopStore(context: ctx)
        await s.refresh(projectId: "p1")
        #expect(s.runs.map(\.id) == ["cmd-0001"])
        #expect(s.history.map(\.loopName) == ["Regression"])
        #expect(ctx.scripted.payload(ctx.scripted.calls(.loopHistory)[0], as: HostApiLoopHistoryRequest.self).projectId == "p1")
    }

    @Test("loop start sends only the project and issue ids, then reloads")
    func loopStart() async {
        ctx.scripted.reply = { cmd, _ in
            switch cmd {
            case .loopStart: return enc(HostApiLoopStartResult(id: "cmd-0002", state: "awaiting_approval"))
            case .loopList: return enc(HostApiLoopListResult(runs: []))
            default: return enc(HostApiLoopHistoryResult(runs: []))
            }
        }
        let s = LoopStore(context: ctx)
        #expect(await s.start(issueIds: ["42", "43"], projectId: "p1"))
        let req = ctx.scripted.payload(ctx.scripted.calls(.loopStart)[0], as: HostApiLoopStartRequest.self)
        #expect(req.issueIds == ["42", "43"] && req.projectId == "p1")
    }

    @Test("a refused start is reported and returns false")
    func loopStartRefused() async {
        ctx.scripted.reply = { _, _ in throw HostApiRejection(replyTo: nil, code: "denied", message: "This account or project cannot start runs from the phone.") }
        let s = LoopStore(context: ctx)
        #expect(await s.start(issueIds: ["1"], projectId: "p1") == false)
        #expect(s.error == "This account or project cannot start runs from the phone.")
    }

    @Test("nothing is sent while the connection is down")
    func offline() async {
        ctx.isConnected = false
        let s = LoopStore(context: ctx)
        await s.refresh(projectId: "p1")
        #expect(ctx.scripted.calls.isEmpty)
    }

    @Test("tasks refresh lists the registry")
    func tasks() async {
        ctx.scripted.reply = { _, _ in enc(HostApiTasksListResult(tasks: [.init(available: true, description: "d", group: "Review", id: "review.code", label: "Code review", scope: "project")])) }
        let s = TasksStore(context: ctx)
        await s.refresh()
        #expect(s.tasks.map(\.id) == ["review.code"])
    }
}
