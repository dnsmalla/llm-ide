import Testing
import Foundation
import SharedProtocol
@testable import LlmIdeMacLib

@MainActor
@Suite("HostApiV1Gateway", .serialized)
final class HostApiV1GatewayTests {
    var sent: [(Int, [String: Any])] = []
    var closed: [Int] = []
    var forwarded: [[String: Any]] = []
    var cancelled: [String] = []
    var pin = "123456"
    var tokens: [String: String] = [:]   // token -> deviceId
    var scopes: [String: [String]] = [:] // deviceId -> granted capabilities
    var pinRotations = 0
    var toolApprovals = false
    var historyLines = [MobileChatLine(role: "user", content: "hi")]

    func gateway() -> HostApiV1Gateway {
        let g = HostApiV1Gateway(dependencies: .init(
            hostName: { "Test Mac" },
            validatePin: { [unowned self] in $0 == self.pin },
            pinConsumed: { [unowned self] in self.pinRotations += 1; self.pin = "654321" },
            issueToken: { [unowned self] id, _, scopes in let t = "tok-\(id)-0123456789"; self.tokens[t] = id; self.scopes[id] = scopes; return t },
            authenticate: { [unowned self] in self.tokens[$0] },
            scopes: { [unowned self] in self.scopes[$0] ?? MobilePairedDeviceStore.legacyHostApiScopes },
            revoke: { [unowned self] id in self.tokens = self.tokens.filter { $0.value != id } },
            capabilities: { [unowned self] in HostApiV1Gateway.capabilities(chatInstalled: true, toolApprovals: self.toolApprovals) },
            tierRefusal: { _ in nil },
            forward: { [unowned self] in self.forwarded.append(try! JSONSerialization.jsonObject(with: $0) as! [String: Any]) },
            history: { [unowned self] _ in .lines(self.historyLines) },
            clear: { .cleared },
            cancel: { [unowned self] in self.cancelled.append($0) },
            log: { _ in }))
        g.send = { [unowned self] s, d in self.sent.append((s, try! JSONSerialization.jsonObject(with: d) as! [String: Any])) }
        g.close = { [unowned self] in self.closed.append($0) }
        return g
    }

    func request(_ id: String, _ command: String, _ payload: String = "{}") -> Data {
        Data(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":1}"#.utf8)
    }
    var last: [String: Any] { sent.last!.1 }
    var lastError: String? { (last["error"] as? [String: Any])?["code"] as? String }

    func paired(_ g: HostApiV1Gateway, session: Int = 1) async {
        g.opened(session: session, peer: "127.0.0.1")
        await g.receive(session: session, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: session, data: request("c-p", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
    }

    @Test("hello, pair, then the PIN rotates and the token re-authenticates a new connection")
    func pairing() async {
        let g = gateway()
        await paired(g)
        let result = last["result"] as! [String: Any]
        #expect(last["replyTo"] as? String == "c-p" && (result["token"] as! String).hasPrefix("tok-h1-"))
        #expect(pinRotations == 1)
        g.opened(session: 2, peer: "127.0.0.1")
        await g.receive(session: 2, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: 2, data: request("c-t", "host.auth.token", #"{"token":"\#(result["token"] as! String)"}"#))
        #expect(last["type"] as? String == "response")
    }

    @Test("a wrong PIN is auth_failed and not retryable; commands before auth are refused")
    func wrongPin() async {
        let g = gateway()
        g.opened(session: 1, peer: "127.0.0.1")
        await g.receive(session: 1, data: request("c-1", "chat.snapshot"))
        #expect(lastError == "auth_failed")
        await g.receive(session: 1, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: 1, data: request("c-p", "host.auth.pair", #"{"pin":"000000"}"#))
        #expect(lastError == "auth_failed" && (last["error"] as! [String: Any])["retryable"] as? Bool == false)
    }

    @Test("chat.send forwards a namespaced v2 chat and routes its reply back as delta + done")
    func chatSend() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello","attachments":[{"name":"a.md","text":"x"}]}"#))
        #expect((last["result"] as! [String: Any])["requestId"] as? String == "c-9")
        #expect(forwarded.last?["commandId"] as? String == "h1.1.c-9")
        #expect((forwarded.last?["files"] as? [[String: Any]])?.first?["name"] as? String == "a.md")
        #expect(g.owns("h1.1.c-9"))
        g.deliver(v2Frame: try! JSONEncoder().encode(Output(commandId: "h1.1.c-9", payload: OutputPayload(stream: "hi", done: true))),
                  internalCommandId: "h1.1.c-9")
        #expect(sent.suffix(2).map { $0.1["command"] as? String } == ["chat.delta", "chat.done"])
        #expect(!g.owns("h1.1.c-9"), "a terminal frame ends ownership")
        let revs = sent.compactMap { $0.1["rev"] as? Int }
        #expect(revs == revs.sorted(), "rev is monotonic per connection")
    }

    @Test("rev is per connection: another session's events do not advance it")
    func revPerSession() async {
        let g = gateway()
        await paired(g, session: 1)
        await paired(g, session: 2)
        #expect(g.rev(for: 1) == 0 && g.rev(for: 2) == 0 && g.rev(for: 9) == nil)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello"}"#))
        let mark = sent.count
        let a = "h1.1.c-9"
        g.deliver(v2Frame: try! JSONEncoder().encode(Output(commandId: a, payload: OutputPayload(stream: "x", done: true))), internalCommandId: a)
        let events = sent[mark...].filter { $0.0 == 1 && $0.1["type"] as? String == "event" }
        #expect(events.compactMap { $0.1["rev"] as? Int } == [1, 2])
        #expect(g.rev(for: 1) == 2 && g.rev(for: 2) == 0, "B is untouched")
        await g.receive(session: 1, data: request("c-p2", "host.ping"))
        #expect(last["rev"] as? Int == 2)
        await g.receive(session: 2, data: request("c-p3", "host.ping"))
        #expect(sent.last?.0 == 2 && last["rev"] as? Int == 0)
    }

    @Test("cancel ends the turn as a cancelled done")
    func cancel() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello"}"#))
        await g.receive(session: 1, data: request("c-x", "chat.cancel"))
        #expect(cancelled == ["h1.1.c-9"] && (last["result"] as! [String: Any])["cancelled"] as? Bool == true)
        g.deliver(v2Frame: try! JSONEncoder().encode(CommandError(commandId: "h1.1.c-9", message: "Cancelled")), internalCommandId: "h1.1.c-9")
        #expect((last["payload"] as! [String: Any])["stopReason"] as? String == "cancelled")
    }

    @Test("an approval answer for a command this session does not own is not_found")
    func approvalOwnership() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-a", "approvals.answer", #"{"requestId":"r","commandId":"someone-else","answers":{}}"#))
        #expect(lastError == "not_found" && forwarded.isEmpty)
    }

    @Test("tool approvals need their capability served; a capability change pushes host.capabilities")
    func capabilities() async {
        toolApprovals = true // paired while served, so it is granted
        let g = gateway()
        await paired(g)
        toolApprovals = false
        g.capabilitiesChanged()
        await g.receive(session: 1, data: request("c-t", "toolApprovals.answer", #"{"requestId":"r","commandId":"c-9","decision":"deny"}"#))
        #expect(lastError == "capability_unavailable")
        toolApprovals = true
        g.capabilitiesChanged()
        #expect(last["command"] as? String == "host.capabilities")
        #expect(((last["payload"] as! [String: Any])["capabilities"] as! [String]).contains("tool_approvals"))
    }

    @Test("snapshot serves chat only")
    func snapshot() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-s", "host.snapshot", #"{"topics":["chat"]}"#))
        #expect(((last["result"] as! [String: Any])["snapshots"] as! [String: Any])["chat"] != nil)
        await g.receive(session: 1, data: request("c-s2", "host.snapshot", #"{"topics":["chat","loop"]}"#))
        #expect(lastError == "capability_unavailable")
    }

    @Test("a long chat snapshot stays under the frame cap and keeps the newest messages")
    func longSnapshot() async {
        // 20 lines of 90k two-byte characters (~3.6 MB) — far past one frame.
        historyLines = (0..<20).map { MobileChatLine(role: $0 % 2 == 0 ? "user" : "assistant", content: "\($0):" + String(repeating: "é", count: 90_000)) }
        var frames: [Data] = []
        let g = gateway()
        let record = g.send
        g.send = { s, d in frames.append(d); record(s, d) }
        await paired(g)
        for (id, command, payload) in [("c-l1", "chat.snapshot", #"{"limit":20}"#), ("c-l2", "host.snapshot", #"{"topics":["chat"]}"#)] {
            await g.receive(session: 1, data: request(id, command, payload))
            #expect(last["type"] as? String == "response")
            #expect(frames.last!.count < HostApi.limits.maxFrameBytes)
            let result = last["result"] as! [String: Any]
            let messages = (result["messages"] ?? (result["snapshots"] as! [String: Any])["chat"].flatMap { ($0 as! [String: Any])["messages"] }) as! [[String: Any]]
            #expect(!messages.isEmpty && messages.count < 20)
            #expect(messages.map { $0["content"] as! String } == historyLines.suffix(messages.count).map(\.content))
        }
        // One newest message alone is always served, whole (within the 100k clamp).
        let one = HostApiV1Gateway.messages([MobileChatLine(role: "user", content: "old"),
                                             MobileChatLine(role: "assistant", content: String(repeating: "\u{1}", count: 100_000))], limit: 2)
        #expect(one.last?.content.utf16.count == 100_000)
    }

    @Test("self-revoke works only with the session's own token, then closes it")
    func revoke() async {
        let g = gateway()
        await paired(g)
        let token = tokens.first!.key
        await g.receive(session: 1, data: request("c-r", "host.auth.revoke", #"{"token":"tok-h1-other-0123456789"}"#))
        #expect(lastError == "denied")
        await g.receive(session: 1, data: request("c-r2", "host.auth.revoke", #"{"token":"\#(token)"}"#))
        let response = sent.first { $0.1["replyTo"] as? String == "c-r2" }?.1
        #expect((response?["result"] as? [String: Any])?["revoked"] as? Bool == true && tokens.isEmpty && closed == [1])
    }

    @Test("self-revoke also closes another live session of the same device")
    func revokeClosesSiblings() async {
        let g = gateway()
        await paired(g)
        let token = tokens.first!.key
        g.opened(session: 2, peer: "127.0.0.1")
        await g.receive(session: 2, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: 2, data: request("c-t", "host.auth.token", #"{"token":"\#(token)"}"#))
        await g.receive(session: 1, data: request("c-r", "host.auth.revoke", #"{"token":"\#(token)"}"#))
        #expect(Set(closed) == [1, 2])
    }

    @Test("a reused in-flight chat.send id is busy and forwards nothing more")
    func reusedId() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"a"}"#))
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"b"}"#))
        #expect(lastError == "busy" && forwarded.count == 1)
    }

    @Test("closeAll cancels every owned command and closes every session")
    func closeAll() async {
        let g = gateway()
        await paired(g)
        await paired(g, session: 2)
        await g.receive(session: 1, data: request("c-1", "chat.send", #"{"text":"a"}"#))
        await g.receive(session: 2, data: request("c-2", "chat.send", #"{"text":"b"}"#))
        g.closeAll()
        #expect(Set(cancelled) == ["h1.1.c-1", "h1.2.c-2"] && Set(closed) == [1, 2])
    }

    @Test("closing a session cancels its commands and drops later frames")
    func closing() async {
        let g = gateway()
        await paired(g)
        await g.receive(session: 1, data: request("c-9", "chat.send", #"{"text":"hello"}"#))
        g.closed(session: 1)
        #expect(cancelled == ["h1.1.c-9"])
        let before = sent.count
        g.deliver(v2Frame: try! JSONEncoder().encode(Output(commandId: "h1.1.c-9", payload: OutputPayload(stream: "late", done: true))), internalCommandId: "h1.1.c-9")
        #expect(sent.count == before)
    }

    @Test("a v2 frame may not name a Host API v1 command id")
    func v1IdRefused() {
        #expect(MobileControlManager.refusesV1CommandId(Data(#"{"type":"llmide_cancel","commandId":"h1.1.c-9"}"#.utf8)))
        #expect(!MobileControlManager.refusesV1CommandId(Data(#"{"type":"llmide_cancel","commandId":"6F1C2E7A-0000-4000-8000-000000000000"}"#.utf8)))
        #expect(!MobileControlManager.refusesV1CommandId(Data(#"{"type":"llmide_chat_history"}"#.utf8)))
        #expect(MobileControlManager.refusesV1CommandId(Data(#"{"type":"h1.1.c-9","commandId":"x"}"#.utf8)))
        #expect(MobileControlManager.refusesV1CommandId(Data(#"{"type":"h1.1.c-9"}"#.utf8)))
        #expect(MobileControlManager.outboundRoute(commandId: "h1.1.c-9", hasGateway: true) == .v1)
        #expect(MobileControlManager.outboundRoute(commandId: "h1.1.c-9", hasGateway: false) == .drop)
        #expect(MobileControlManager.outboundRoute(commandId: "abc", hasGateway: false) == .v2)
        #expect(MobileControlManager.outboundRoute(commandId: nil, hasGateway: true) == .v2)
    }
}
