import Testing
import Foundation
import SharedProtocol

@Suite("Host API client logic")
struct HostApiClientLogicTests {
    private let busy = HostApiRejection(replyTo: nil, code: "busy", message: "full", retryable: true)
    private let badPin = HostApiRejection(replyTo: "c-2", code: "auth_failed", message: "Wrong PIN")

    @Test("rev: in order after a baseline, a skip is a gap, and a response never moves the baseline back")
    func revTracker() {
        var t = HostApiRevTracker()
        #expect(t.observe(event: 3) == .gap, "no snapshot yet: the first event cannot be trusted")
        t.reset()
        t.baseline(4)
        #expect(t.observe(event: 5) == .inOrder)
        #expect(t.observe(event: 6) == .inOrder)
        #expect(t.observe(event: 9) == .gap, "9 > 6 + 1")
        #expect(t.observe(event: 10) == .inOrder, "the gap event becomes the new baseline")
        t.baseline(7)
        #expect(t.rev == 10)
        t.baseline(20)
        #expect(t.observe(event: 21) == .inOrder, "a response rev absorbs other sessions' events")
    }

    @Test("negotiation: no v1 endpoint goes straight to v2")
    func noEndpoint() {
        var n = HostApiNegotiation()
        #expect(n.handle(.start(v1Endpoint: false)) == .connectV2)
        #expect(n.phase == .v2)
    }

    @Test("negotiation: hello then auth reaches v1")
    func happyPath() {
        var n = HostApiNegotiation()
        #expect(n.handle(.start(v1Endpoint: true)) == .openV1AndHello)
        #expect(n.handle(.helloAnswered(apiVersion: 1, requiresAuth: true)) == .sendAuth)
        #expect(n.handle(.authAnswered) == .ready)
        #expect(n.phase == .v1)
    }

    @Test("negotiation: silence, a foreign version or a version refusal falls back to v2")
    func fallbacks() {
        for input: HostApiNegotiation.Input in [
            .silent,
            .helloAnswered(apiVersion: 2, requiresAuth: true),
            .helloRefused(.init(replyTo: "c-1", code: "capability_unavailable", message: "v1 only")),
            .helloRefused(.init(replyTo: "c-1", code: "unknown_command", message: "?")),
        ] {
            var n = HostApiNegotiation()
            _ = n.handle(.start(v1Endpoint: true))
            #expect(n.handle(input) == .connectV2, "\(input)")
        }
    }

    @Test("negotiation: once a v1 host answered, a refusal or silence never falls back to v2")
    func noFallbackAfterV1Answered() {
        var a = HostApiNegotiation()
        _ = a.handle(.start(v1Endpoint: true))
        #expect(a.handle(.helloRefused(busy)) == .fail(busy))

        var b = HostApiNegotiation()
        _ = b.handle(.start(v1Endpoint: true)); _ = b.handle(.helloAnswered(apiVersion: 1, requiresAuth: true))
        #expect(b.handle(.authRefused(badPin)) == .fail(badPin))

        var c = HostApiNegotiation()
        _ = c.handle(.start(v1Endpoint: true)); _ = c.handle(.helloAnswered(apiVersion: 1, requiresAuth: true))
        guard case .fail(let r) = c.handle(.silent) else { Issue.record("expected fail"); return }
        #expect(r.code == "host_unreachable"); #expect(r.retryable)
    }

    @Test("negotiation: out-of-order inputs are ignored")
    func ignored() {
        var n = HostApiNegotiation()
        #expect(n.handle(.authAnswered) == .ignore)
        _ = n.handle(.start(v1Endpoint: false))
        #expect(n.handle(.silent) == .ignore)
    }

    @Test("endpoint: plaintext only to loopback, default path added")
    func endpoint() {
        #expect(HostApiEndpoint("ws://127.0.0.1:3016")?.url.absoluteString == "ws://127.0.0.1:3016/host-api/v1")
        #expect(HostApiEndpoint("ws://localhost:3017/host-api/v1")?.url.path == "/host-api/v1")
        #expect(HostApiEndpoint("ws://192.168.1.20:3016") == nil, "plaintext off loopback")
        #expect(HostApiEndpoint("ws://127.0.0.1") == nil, "the port is never assumed")
        #expect(HostApiEndpoint("http://127.0.0.1:3016") == nil)
        #expect(HostApiEndpoint("") == nil)
    }
}

@Suite("Host API client logic: hardening")
struct HostApiClientLogicHardeningTests {
    @Test("rev: Int.max baseline never traps; duplicate or older is not a gap")
    func revOverflow() {
        var t = HostApiRevTracker()
        t.baseline(Int.max)
        #expect(t.observe(event: Int.max) == .inOrder)
        #expect(t.observe(event: 5) == .inOrder)
        #expect(t.observe(event: Int.min) == .inOrder)
        var u = HostApiRevTracker(); u.baseline(5)
        #expect(u.observe(event: 5) == .inOrder)
        #expect(u.observe(event: 2) == .inOrder)
        var n = HostApiRevTracker(); n.baseline(Int.min)
        #expect(n.observe(event: Int.max) == .gap)
        var m = HostApiRevTracker(); m.baseline(-1)
        #expect(m.observe(event: 0) == .inOrder)
    }

    @Test("negotiation: a second start is ignored")
    func secondStart() {
        var n = HostApiNegotiation()
        _ = n.handle(.start(v1Endpoint: true))
        #expect(n.handle(.start(v1Endpoint: true)) == .ignore)
        #expect(n.phase == .awaitingHello)
    }

    @Test("endpoint: host bypasses refused, IPv6 and case accepted, only the v1 path allowed")
    func endpointStrict() {
        for bad in ["ws://127.0.0.1.evil.com:3016", "ws://localhost.:3016", "ws://user@127.0.0.1:3016",
                    "ws://127.0.0.1:3016/foo", "ws://127.0.0.1:3016?x=1", "ws://127.0.0.1:3016/host-api/v1?x=1",
                    "ws://127.0.0.1:3016#f"] {
            #expect(HostApiEndpoint(bad) == nil, "\(bad)")
        }
        #expect(HostApiEndpoint("ws://[::1]:3016")?.url.absoluteString == "ws://[::1]:3016/host-api/v1")
        #expect(HostApiEndpoint("WS://LOCALHOST:3016")?.url.absoluteString == "ws://localhost:3016/host-api/v1")
        #expect(HostApiEndpoint("ws://127.0.0.1:3016/host-api/v1")?.url.path == "/host-api/v1")
    }
}

@Suite("Host API client logic: pairing safety")
struct HostApiPairingSafetyTests {
    @Test("a v1-only phone never falls back to v2; a v2 credential or no v1 token does")
    func fallback() {
        #expect(!HostApiNegotiation.fallsBackToV2(hasV1Token: true, hasV2Credential: false, pinned: false))
        #expect(HostApiNegotiation.fallsBackToV2(hasV1Token: true, hasV2Credential: true, pinned: false))
        #expect(HostApiNegotiation.fallsBackToV2(hasV1Token: false, hasV2Credential: false, pinned: false))
        #expect(HostApiNegotiation.fallsBackToV2(hasV1Token: false, hasV2Credential: true, pinned: false))
    }

    @Test("a pinned wss endpoint never falls back to cleartext v2, whatever credentials the phone holds")
    func pinnedNeverDowngrades() {
        for v1 in [false, true] { for v2 in [false, true] {
            #expect(!HostApiNegotiation.fallsBackToV2(hasV1Token: v1, hasV2Credential: v2, pinned: true), "\(v1) \(v2)")
        } }
    }

    @Test("only a non-retryable auth_failed clears the credentials")
    func clears() {
        func r(_ code: String, _ retryable: Bool = false) -> HostApiRejection {
            HostApiRejection(replyTo: nil, code: code, message: "m", retryable: retryable)
        }
        #expect(HostApiNegotiation.clearsCredentials(r("auth_failed")))
        #expect(!HostApiNegotiation.clearsCredentials(r("auth_failed", true)))
        for code in ["internal", "invalid_payload", "denied", "busy", "rate_limited", "host_unreachable", "capability_unavailable"] {
            #expect(!HostApiNegotiation.clearsCredentials(r(code)))
        }
    }
}

@Suite("HostApiChatTurn")
struct HostApiChatTurnTests {
    @Test("Stop ends a v1 turn locally unless the host cancelled it; v2 waits for the Mac")
    func endsAfterCancel() {
        #expect(HostApiChatTurn.endsAfterCancel(apiVersion: 1, cancelled: false))
        #expect(HostApiChatTurn.endsAfterCancel(apiVersion: 1, cancelled: nil))
        #expect(!HostApiChatTurn.endsAfterCancel(apiVersion: 1, cancelled: true))
        #expect(!HostApiChatTurn.endsAfterCancel(apiVersion: 2, cancelled: false))
        #expect(!HostApiChatTurn.endsAfterCancel(apiVersion: 2, cancelled: nil))
    }
}

@Suite("HostApiChatSendPolicy")
struct HostApiChatSendPolicyTests {
    typealias P = HostApiChatSendPolicy

    @Test("the limits equal commands.json chat.send")
    func limitsMatchSchema() throws {
        let props = try #require(HostApiSchemas.request(for: .chatSend)["properties"] as? [String: Any])
        let text = try #require(props["text"] as? [String: Any])
        let att = try #require(props["attachments"] as? [String: Any])
        let item = try #require((att["items"] as? [String: Any])?["properties"] as? [String: Any])
        #expect(text["maxLength"] as? Int == P.maxTextUTF16)
        #expect(text["minLength"] as? Int == 1)
        #expect(att["maxItems"] as? Int == P.maxAttachments)
        #expect((item["text"] as? [String: Any])?["maxLength"] as? Int == P.maxAttachmentTextUTF16)
        #expect((item["name"] as? [String: Any])?["maxLength"] as? Int == P.maxNameUTF16)
    }

    @Test("a files-only message carries the file names as text and validates against the schema")
    func filesOnly() throws {
        guard case .send(let r) = P.request(text: "", files: [.init(name: "a.pdf", text: "x"), .init(name: "b.md", text: "y")])
        else { Issue.record("refused"); return }
        #expect(r.text == "Attached: a.pdf, b.md")
        _ = try HostApiFrame.request(id: "c-1", command: .chatSend, payload: r)   // throws invalid_payload if not
    }

    @Test("plain text passes unchanged, with no attachments key")
    func plain() {
        #expect(P.request(text: "hi", files: []) == .send(HostApiChatSendRequest(text: "hi")))
    }

    @Test("oversized or too many attachments, or overlong text, are refused with a user sentence")
    func refusals() {
        let big = String(repeating: "a", count: P.maxAttachmentTextUTF16 + 1)
        #expect(P.request(text: "hi", files: [.init(name: "big.pdf", text: big)]) == .refuse(P.fileTooLarge))
        #expect(P.request(text: "hi", files: Array(repeating: .init(name: "f", text: "x"), count: 11)) == .refuse(P.tooManyFiles))
        #expect(P.request(text: String(repeating: "a", count: P.maxTextUTF16 + 1), files: []) == .refuse(P.textTooLong))
        // Ten files at the per-file limit (UTF-16) pass each check, but as 2-byte UTF-8 they exceed the 1 MiB frame.
        let full = String(repeating: "é", count: P.maxAttachmentTextUTF16)
        #expect(P.request(text: "hi", files: Array(repeating: .init(name: "f", text: full), count: 10)) == .refuse(P.fileTooLarge))
    }
}

@Suite("HostApiBackoff")
struct HostApiBackoffTests {
    @Test("the existing schedule is unchanged (2 s × Int(1.5ⁿ)), capped at 30 s, and never overflows")
    func schedule() {
        #expect(HostApiBackoff.delayMs(attempt: 0) == 0)
        #expect(HostApiBackoff.delayMs(attempt: 1) == 2_000)
        #expect(HostApiBackoff.delayMs(attempt: 2) == 2_000)
        #expect(HostApiBackoff.delayMs(attempt: 3) == 4_000)
        #expect(HostApiBackoff.delayMs(attempt: 4) == 6_000)
        #expect(HostApiBackoff.delayMs(attempt: 9) == 30_000)
        #expect(HostApiBackoff.delayMs(attempt: 10_000) == 30_000)
    }

    @Test("retryAfterMs stretches the delay, capped at 5 minutes; zero or nil changes nothing")
    func retryAfter() {
        #expect(HostApiBackoff.delayMs(attempt: 1, retryAfterMs: 60_000) == 60_000)
        #expect(HostApiBackoff.delayMs(attempt: 1, retryAfterMs: 900_000) == 300_000)
        #expect(HostApiBackoff.delayMs(attempt: 9, retryAfterMs: 500) == 30_000)
        #expect(HostApiBackoff.delayMs(attempt: 1, retryAfterMs: 0) == 2_000)
        #expect(HostApiBackoff.delayMs(attempt: 0, retryAfterMs: 5_000) == 5_000)
    }
}

@Suite("HostApiChatNotices")
struct HostApiChatNoticesTests {
    @Test("the composer explains a chat-less host only when connected and the host lists capabilities")
    func composer() {
        #expect(HostApiChatNotices.composer(connected: true, capabilities: ["host"]) == HostApiChatNotices.chatOff)
        #expect(HostApiChatNotices.composer(connected: true, capabilities: []) == HostApiChatNotices.chatOff)
        #expect(HostApiChatNotices.composer(connected: true, capabilities: ["chat"]) == nil)
        #expect(HostApiChatNotices.composer(connected: true, capabilities: nil) == nil, "unknown = everything")
        #expect(HostApiChatNotices.composer(connected: false, capabilities: ["host"]) == nil)
    }

    @Test("only a local EncodingError disconnects after a failed chat.send")
    func sendFailure() {
        let encoding = EncodingError.invalidValue(Double.nan, .init(codingPath: [], debugDescription: "nan"))
        let decoding = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad"))
        #expect(HostApiChatNotices.disconnectsAfterSendFailure(encoding))
        #expect(!HostApiChatNotices.disconnectsAfterSendFailure(decoding))
        #expect(!HostApiChatNotices.disconnectsAfterSendFailure(HostApiRejection(replyTo: nil, code: "internal", message: "x")))
    }

    @Test("the tool-approvals notice is the Mac's v2 ApprovalCleared reason, verbatim")
    func macText() {
        #expect(HostApiChatNotices.toolApprovalsOff == "Tool requests can no longer be approved from the phone.")
    }
}
