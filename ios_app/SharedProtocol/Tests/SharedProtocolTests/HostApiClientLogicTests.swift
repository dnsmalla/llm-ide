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
        #expect(!HostApiNegotiation.fallsBackToV2(hasV1Token: true, hasV2Credential: false))
        #expect(HostApiNegotiation.fallsBackToV2(hasV1Token: true, hasV2Credential: true))
        #expect(HostApiNegotiation.fallsBackToV2(hasV1Token: false, hasV2Credential: false))
        #expect(HostApiNegotiation.fallsBackToV2(hasV1Token: false, hasV2Credential: true))
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
