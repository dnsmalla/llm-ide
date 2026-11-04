import Testing
import Foundation
import SharedProtocol
@testable import LlmIdeMacLib

/// Host API v1 token scopes (Plan 6 Task 7) — the Swift twin of extension/tests/host-api-scopes.test.mjs.
/// A token carries the capabilities served when it was paired; a session's effective set is served ∩ granted.
@MainActor
@Suite("HostApiV1Scopes", .serialized)
final class HostApiV1ScopesTests {
    var sent: [(Int, [String: Any])] = []
    var toolApprovals = false
    let store = MobilePairedDeviceStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("h1-scopes-\(UUID().uuidString)/devices.json"))

    func gateway() -> HostApiV1Gateway {
        let g = HostApiV1Gateway(dependencies: .init(
            hostName: { "Test Mac" },
            validatePin: { $0 == "123456" },
            pinConsumed: {},
            issueToken: { [store] id, name, scopes in store.issueToken(deviceId: id, name: name, scopes: scopes) },
            authenticate: { [store] in store.authenticate(token: $0) },
            scopes: { [store] in store.scopes(deviceId: $0) },
            revoke: { [store] in store.revoke(id: $0) },
            capabilities: { [unowned self] in HostApiV1Gateway.capabilities(chatInstalled: true, toolApprovals: self.toolApprovals) },
            tierRefusal: { _ in nil },
            forward: { _ in },
            history: { _ in .lines([]) },
            clear: { .cleared },
            cancel: { _ in },
            log: { _ in }))
        g.send = { [unowned self] s, d in self.sent.append((s, try! JSONSerialization.jsonObject(with: d) as! [String: Any])) }
        return g
    }

    func request(_ id: String, _ command: String, _ payload: String = "{}") -> Data {
        Data(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":1}"#.utf8)
    }
    var last: [String: Any] { sent.last!.1 }
    var lastError: [String: Any]? { last["error"] as? [String: Any] }
    var lastCaps: [String]? {
        ((last["result"] ?? last["payload"]) as? [String: Any])?["capabilities"] as? [String]
    }

    func open(_ g: HostApiV1Gateway, _ session: Int, _ auth: Data) async {
        g.opened(session: session, peer: "127.0.0.1")
        await g.receive(session: session, data: request("c-h", "host.hello", #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: session, data: auth)
    }
    var pair: Data { request("c-p", "host.auth.pair", #"{"pin":"123456"}"#) }
    func token(_ t: String) -> Data { request("c-t", "host.auth.token", #"{"token":"\#(t)"}"#) }

    func answerTool(_ g: HostApiV1Gateway, _ session: Int) async {
        await g.receive(session: session, data: request("c-9", "chat.send", #"{"text":"hello"}"#))
        await g.receive(session: session, data: request("c-a", "toolApprovals.answer", #"{"requestId":"r","commandId":"c-9","decision":"allow_once"}"#))
    }

    @Test("a capability turned on after pairing is not granted: the push leaves it out and the answer is denied")
    func enabledAfterPairing() async {
        let g = gateway()
        await open(g, 1, pair)
        #expect(lastCaps == ["host", "chat", "approvals"])
        toolApprovals = true
        let before = sent.count
        g.capabilitiesChanged()
        #expect(sent.count == before, "the session's own list did not change, so nothing is pushed")
        await answerTool(g, 1)
        #expect(lastError?["code"] as? String == "denied")
        #expect((lastError?["message"] as? String)?.contains("pair again") == true)
    }

    @Test("paired while served: the token grants tool_approvals on a new session and the answer is accepted")
    func pairedWhileServed() async {
        toolApprovals = true
        let g = gateway()
        await open(g, 1, pair)
        #expect(lastCaps == ["host", "chat", "approvals", "tool_approvals"])
        let t = (last["result"] as! [String: Any])["token"] as! String
        await open(g, 2, token(t))
        #expect(lastCaps == ["host", "chat", "approvals", "tool_approvals"])
        await answerTool(g, 2)
        #expect((last["result"] as? [String: Any])?["accepted"] as? Bool == true)
    }

    @Test("a legacy token (no stored scopes) gets host, chat and approvals, never tool_approvals")
    func legacyToken() async {
        toolApprovals = true
        let legacy = store.issueToken(deviceId: "h1-old", name: "old")
        let g = gateway()
        await open(g, 1, token(legacy))
        #expect(lastCaps == ["host", "chat", "approvals"])
        await answerTool(g, 1)
        #expect(lastError?["code"] as? String == "denied")
    }

    @Test("granted but no longer served: capability_unavailable, and the push drops it")
    func grantedNotServed() async {
        toolApprovals = true
        let g = gateway()
        await open(g, 1, pair)
        toolApprovals = false
        g.capabilitiesChanged()
        #expect(last["command"] as? String == "host.capabilities" && lastCaps == ["host", "chat", "approvals"])
        await g.receive(session: 1, data: request("c-a", "toolApprovals.answer", #"{"requestId":"r","commandId":"c-9","decision":"deny"}"#))
        #expect(lastError?["code"] as? String == "capability_unavailable")
        toolApprovals = true
        g.capabilitiesChanged()
        #expect(lastCaps?.contains("tool_approvals") == true, "granted again once served")
    }

    @Test("store: scopes round-trip; a file written without scopes loads with the legacy set")
    func storeRoundTrip() throws {
        _ = store.issueToken(deviceId: "h1-A", name: "web", scopes: ["host", "chat"])
        #expect(store.scopes(deviceId: "h1-A") == ["host", "chat"])
        #expect(store.scopes(deviceId: "h1-missing") == MobilePairedDeviceStore.legacyHostApiScopes)

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("h1-scopes-old-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(#"[{"id":"h1-B","name":"web","tokenHash":"x","pairedAt":"2026-01-01T00:00:00Z","lastSeenAt":"2026-01-01T00:00:00Z"}]"#.utf8).write(to: url)
        let old = MobilePairedDeviceStore(fileURL: url)
        #expect(old.device(id: "h1-B") != nil, "the old file still loads")
        #expect(old.scopes(deviceId: "h1-B") == ["host", "chat", "approvals"])
    }
}
