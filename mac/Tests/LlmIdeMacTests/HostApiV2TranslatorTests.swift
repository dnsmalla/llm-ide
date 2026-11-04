import Testing
import Foundation
import SharedProtocol
@testable import LlmIdeMacLib

@Suite("HostApiV2Translator")
struct HostApiV2TranslatorTests {
    private func v2<T: Encodable>(_ m: T) -> Data { try! JSONEncoder().encode(m) }
    private func decode<T: Decodable>(_ t: T.Type, _ e: HostApiV1EventOut) -> T { try! JSONDecoder().decode(T.self, from: e.payload) }

    @Test("progress labels are dropped; the final reply is delta then done")
    func output() {
        let progress = HostApiV2Translator.translate(v2(Output(commandId: "h1.1.c-1", payload: OutputPayload(stream: "Reading…", done: false))),
                                                     external: "c-1", cancelledByClient: false)
        #expect(progress == HostApiV1Translation(events: [], terminal: false))
        let done = HostApiV2Translator.translate(v2(Output(commandId: "h1.1.c-1", payload: OutputPayload(stream: "Hello", done: true))),
                                                 external: "c-1", cancelledByClient: false)
        #expect(done.terminal)
        #expect(done.events.map(\.command) == ["chat.delta", "chat.done"])
        #expect(decode(HostApiChatDeltaEvent.self, done.events[0]).text == "Hello")
        #expect(decode(HostApiChatDoneEvent.self, done.events[1]) == HostApiChatDoneEvent(requestId: "c-1"))
    }

    @Test("a long reply is split into schema-sized deltas")
    func chunking() {
        let reply = String(repeating: "a", count: 250_000)
        let t = HostApiV2Translator.translate(v2(Output(commandId: "x", payload: OutputPayload(stream: reply, done: true))),
                                              external: "c-1", cancelledByClient: false)
        let deltas = t.events.filter { $0.command == "chat.delta" }.map { decode(HostApiChatDeltaEvent.self, $0).text }
        #expect(deltas.map(\.utf16.count) == [100_000, 100_000, 50_000])
        #expect(deltas.joined() == reply)
    }

    @Test("an error ends the turn as chat.error, or as a cancelled done when the client cancelled")
    func errors() {
        let e = HostApiV2Translator.translate(v2(CommandError(commandId: "x", message: "Engine busy")), external: "c-1", cancelledByClient: false)
        #expect(e.terminal && e.events.map(\.command) == ["chat.error"])
        #expect(decode(HostApiChatErrorEvent.self, e.events[0]) == HostApiChatErrorEvent(message: "Engine busy", retryable: false))
        let c = HostApiV2Translator.translate(v2(CommandError(commandId: "x", message: "Cancelled")), external: "c-1", cancelledByClient: true)
        #expect(decode(HostApiChatDoneEvent.self, c.events[0]) == HostApiChatDoneEvent(requestId: "c-1", stopReason: "cancelled"))
    }

    @Test("approval request and cleared map with the external command id and clamped text")
    func approvals() {
        let q = MobileApprovalQuestion(question: "Pick", header: "A very long header", options: [MobileApprovalOption(label: "Yes", description: nil)], multiSelect: false)
        let r = HostApiV2Translator.translate(v2(ApprovalRequest(commandId: "h1.1.c-1", requestId: "r-1", questions: [q])), external: "c-1", cancelledByClient: false)
        let ev = decode(HostApiApprovalRequestEvent.self, r.events[0])
        #expect(r.events.map(\.command) == ["approval.request"] && !r.terminal)
        #expect(ev.commandId == "c-1" && ev.requestId == "r-1" && ev.questions[0].header == "A very long ")
        let cl = HostApiV2Translator.translate(v2(ApprovalCleared(commandId: "h1.1.c-1", requestId: "r-1", reason: "done")), external: "c-1", cancelledByClient: false)
        #expect(decode(HostApiApprovalClearedEvent.self, cl.events[0]) == HostApiApprovalClearedEvent(commandId: "c-1", reason: "done", requestId: "r-1"))
    }

    @Test("a tool request is clamped and then marked truncated")
    func toolApproval() {
        let req = ToolApprovalRequest(commandId: "h1.1.c-1", requestId: "r-2", toolName: "Edit", summary: nil, filePath: "a.swift",
                                      oldString: String(repeating: "o", count: 30_000), newString: "n", contentPreview: nil,
                                      command: nil, truncated: false, replaceAll: nil, overwrites: nil)
        let t = HostApiV2Translator.translate(v2(req), external: "c-1", cancelledByClient: false)
        let ev = decode(HostApiToolApprovalRequestEvent.self, t.events[0])
        #expect(ev.truncated && ev.oldString?.utf16.count == 20_000 && ev.commandId == "c-1")
    }

    @Test("frames v1 has no event for are dropped")
    func unknown() {
        #expect(HostApiV2Translator.translate(Data(#"{"type":"mac_capabilities","capabilities":[]}"#.utf8), external: "c-1", cancelledByClient: false).events.isEmpty)
    }
}
