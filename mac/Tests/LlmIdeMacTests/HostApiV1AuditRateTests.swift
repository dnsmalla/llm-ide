import Testing
import Foundation
import Network
@testable import LlmIdeMacLib

/// Host API v1 audit log and per-session rate limits (Plan 6 Task 8) — the Swift twin of
/// extension/tests/host-api-audit-rate.test.mjs. Same scenarios, same event names and limits.
@MainActor
@Suite("HostApiV1AuditRate", .serialized)
final class HostApiV1AuditRateTests {
    var sent: [(Int, [String: Any])] = []
    var closed: [Int] = []
    var forwarded = 0
    var audits: [[String?]] = []   // [event, peer, deviceId, detail, dedupeKey]
    var clock = Date(timeIntervalSince1970: 1_000_000)
    var toolApprovals = false
    let pin = "123456"
    let store = MobilePairedDeviceStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("h1-audit-\(UUID().uuidString)/devices.json"))

    static func tempURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("h1-audit-\(UUID().uuidString)/host-api-audit.jsonl")
    }

    func gateway() -> HostApiV1Gateway {
        let g = HostApiV1Gateway(dependencies: .init(
            hostName: { "Test Mac" },
            validatePin: { [unowned self] in $0 == self.pin },
            pinConsumed: {},
            issueToken: { [store] id, name, scopes in store.issueToken(deviceId: id, name: name, scopes: scopes) },
            authenticate: { [store] in store.authenticate(token: $0) },
            scopes: { [store] in store.scopes(deviceId: $0) },
            revoke: { [store] in store.revoke(id: $0) },
            capabilities: { [unowned self] in HostApiV1Gateway.capabilities(chatInstalled: true, toolApprovals: self.toolApprovals) },
            tierRefusal: { _ in nil },
            forward: { [unowned self] _ in self.forwarded += 1 },
            history: { _ in .lines([]) },
            clear: { .cleared },
            cancel: { _ in },
            log: { _ in },
            certificateFingerprint: { nil },
            audit: { [unowned self] e, p, d, det, k in self.audits.append([e, p, d, det, k]) },
            now: { [unowned self] in self.clock }))
        g.send = { [unowned self] s, d in self.sent.append((s, try! JSONSerialization.jsonObject(with: d) as! [String: Any])) }
        g.close = { [unowned self] in self.closed.append($0) }
        return g
    }

    func request(_ id: String, _ command: String, _ payload: String = "{}") -> Data {
        Data(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":1}"#.utf8)
    }
    static let hello = #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#
    var last: [String: Any] { sent.last!.1 }
    var lastError: [String: Any]? { last["error"] as? [String: Any] }
    var retryAfterMs: Int { (lastError?["details"] as? [String: Any])?["retryAfterMs"] as? Int ?? 0 }
    func events(_ name: String) -> [[String?]] { audits.filter { $0[0] == name } }

    /// hello + pair; returns the token.
    @discardableResult
    func paired(_ g: HostApiV1Gateway, session: Int = 1, peer: String = "10.0.0.1") async -> String {
        g.opened(session: session, peer: peer)
        await g.receive(session: session, data: request("c-h", "host.hello", Self.hello))
        await g.receive(session: session, data: request("c-p", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
        return (last["result"] as! [String: Any])["token"] as! String
    }

    func tokenAuth(_ g: HostApiV1Gateway, session: Int, token: String, peer: String = "10.0.0.1") async {
        g.opened(session: session, peer: peer)
        await g.receive(session: session, data: request("c-h", "host.hello", Self.hello))
        await g.receive(session: session, data: request("c-t", "host.auth.token", #"{"token":"\#(token)"}"#))
    }

    // MARK: - 1. Buckets

    @Test("bucket: 40 frames pass, the 41st waits 0.1 s, one more at t=0.1; 6 turns pass, the 7th waits 10 s")
    func bucket() {
        let t0 = Date(timeIntervalSince1970: 0)
        var frames = HostApiV1TokenBucket(capacity: HostApiV1RateLimits.frameCapacity, perSecond: HostApiV1RateLimits.framePerSecond, now: t0)
        for _ in 0..<40 { #expect(frames.take(now: t0) == nil) }
        #expect(abs((frames.take(now: t0) ?? 0) - 0.1) < 1e-9)
        #expect(frames.take(now: t0.addingTimeInterval(0.1)) == nil)
        var turns = HostApiV1TokenBucket(capacity: HostApiV1RateLimits.turnCapacity, perSecond: HostApiV1RateLimits.turnPerSecond, now: t0)
        for _ in 0..<6 { #expect(turns.take(now: t0) == nil) }
        #expect(abs((turns.take(now: t0) ?? 0) - 10) < 1e-9)
    }

    @Test("the shared limits match the desktop RATE_LIMITS and audit constants")
    func limits() {
        #expect(HostApiV1RateLimits.frameCapacity == 40 && HostApiV1RateLimits.framePerSecond == 10)
        #expect(HostApiV1RateLimits.turnCapacity == 6 && HostApiV1RateLimits.turnPerSecond == 0.1)
        #expect(HostApiV1RateLimits.closeAfterRefusals == 100)
        #expect(HostApiV1AuditLog.dedupeWindow == 60 && HostApiV1AuditLog.detailMax == 200)
        #expect(HostApiV1AuditLog.eventCapPerMinute == 60)
        #expect(HostApiV1Gateway.maxUnauthenticatedPerPeer == 2 && HostApiV1Gateway.authDeadline == 10)
        #expect(HostApiV1Listener.maxBufferedBytes == 4 * 1024 * 1024)
    }

    // MARK: - 2-4. Gateway limits

    @Test("gateway: the 41st host.ping in one tick is rate_limited, retryable, retryAfterMs >= 100, with its id")
    func frameLimit() async {
        let g = gateway()
        g.opened(session: 1, peer: "10.0.0.1")
        for i in 1...41 { await g.receive(session: 1, data: request("c-\(i)", "host.ping")) }
        #expect(lastError?["code"] as? String == "rate_limited")
        #expect(lastError?["retryable"] as? Bool == true)
        #expect(retryAfterMs >= 100)
        #expect(last["replyTo"] as? String == "c-41")
        #expect(sent.dropLast().allSatisfy { ($0.1["error"] as? [String: Any])?["code"] as? String != "rate_limited" })
    }

    @Test("a refused frame whose id cannot be read cheaply carries no replyTo")
    func frameLimitNoId() async {
        let g = gateway()
        g.opened(session: 1, peer: "10.0.0.1")
        for i in 1...40 { await g.receive(session: 1, data: request("c-\(i)", "host.ping")) }
        await g.receive(session: 1, data: Data("not json".utf8))
        #expect(lastError?["code"] as? String == "rate_limited")
        #expect(last["replyTo"] == nil || last["replyTo"] is NSNull)
        #expect(HostApiV1Gateway.cheapId(request("abc", "host.ping")) == "abc")
        // A payload's nested "id" never matches: only scalar envelope members may precede the top-level id.
        #expect(HostApiV1Gateway.cheapId(Data(#"{"payload":{"id":"inner"},"id":"outer"}"#.utf8)) == nil)
        #expect(HostApiV1Gateway.cheapId(Data(#"{"apiVersion":1,"type":"request","id":"x-1"}"#.utf8)) == "x-1")
    }

    @Test("140 frames in one tick close the session after the 100th refusal and write rate_closed")
    func closeAfterRefusals() async {
        let g = gateway()
        g.opened(session: 1, peer: "10.0.0.1")
        for i in 1...140 { await g.receive(session: 1, data: request("c-\(i)", "host.ping")) }
        #expect(closed == [1])
        #expect(sent.count == 40 + 100)
        #expect(events("rate_closed").count == 1)
        #expect(events("rate_closed").first?[1] == "10.0.0.1" && events("rate_closed").first?[4] == "10.0.0.1")
    }

    @Test("a 7th chat.send within 10 s on the same device, even from a new session, is rate_limited")
    func turnLimit() async {
        let g = gateway()
        let token = await paired(g)
        for i in 1...3 { await g.receive(session: 1, data: request("s-\(i)", "chat.send", #"{"text":"hi"}"#)) }
        await tokenAuth(g, session: 2, token: token)
        for i in 4...6 { await g.receive(session: 2, data: request("s-\(i)", "chat.send", #"{"text":"hi"}"#)) }
        #expect(forwarded == 6)
        await g.receive(session: 2, data: request("s-7", "chat.send", #"{"text":"hi"}"#))
        #expect(lastError?["code"] as? String == "rate_limited")
        #expect(retryAfterMs >= 10_000 - 1)
        #expect(forwarded == 6)
        clock = clock.addingTimeInterval(10)
        await g.receive(session: 2, data: request("s-8", "chat.send", #"{"text":"hi"}"#))
        #expect(forwarded == 7)
    }

    // MARK: - 5. Audit rows

    @Test("audit rows: pair_failed, pair_ok, token_failed, scope_denied, revoke_self; no PIN, token or text")
    func auditRows() async throws {
        let g = gateway()
        g.opened(session: 1, peer: "10.0.0.1")
        await g.receive(session: 1, data: request("c-h", "host.hello", Self.hello))
        await g.receive(session: 1, data: request("c-p", "host.auth.pair", #"{"pin":"999999"}"#))
        #expect(events("pair_failed").first?[1] == "10.0.0.1")
        clock = clock.addingTimeInterval(5)   // past the 1 s PIN penalty
        await g.receive(session: 1, data: request("c-p2", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
        let token = (last["result"] as! [String: Any])["token"] as! String
        let ok = try #require(events("pair_ok").first)
        #expect(ok[2]?.hasPrefix("h1-") == true && ok[3] == "t")

        await tokenAuth(g, session: 2, token: "wrong-token-0123456789", peer: "10.0.0.2")
        #expect(events("token_failed").first?[1] == "10.0.0.2")

        await g.receive(session: 1, data: request("s-1", "chat.send", #"{"text":"secret frame text"}"#))
        toolApprovals = true   // served now, not granted at pairing
        await g.receive(session: 1, data: request("c-x", "toolApprovals.answer", #"{"commandId":"s-1","requestId":"r","decision":"allow_once"}"#))
        let denied = try #require(events("scope_denied").first)
        #expect(denied[3] == "tool_approvals" && denied[4] == "\(ok[2]!):tool_approvals")

        await g.receive(session: 1, data: request("c-r", "host.auth.revoke", #"{"token":"\#(token)"}"#))
        #expect(events("revoke_self").first?[2] == ok[2])

        let json = audits.map { $0.map { $0 ?? "" }.joined(separator: "|") }.joined(separator: "\n")
        for secret in [pin, "999999", token, "wrong-token-0123456789", "secret frame text"] { #expect(!json.contains(secret)) }
    }

    @Test("throttled attempts write pair_throttled / token_throttled, de-duplicated per peer; the buckets are split")
    func throttleEvents() async {
        let g = gateway()
        let token = await paired(g, session: 1, peer: "10.0.0.9")
        g.opened(session: 2, peer: "10.0.0.5")
        await g.receive(session: 2, data: request("c-h", "host.hello", Self.hello))
        await g.receive(session: 2, data: request("c-p", "host.auth.pair", #"{"pin":"000000"}"#))
        await g.receive(session: 2, data: request("c-p2", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
        #expect(events("pair_throttled").first.map { [$0[1], $0[3], $0[4]] } == ["10.0.0.5", "wait", "10.0.0.5"])
        // A wrong PIN from this peer does not delay its token reconnect (separate bucket).
        await tokenAuth(g, session: 3, token: token, peer: "10.0.0.5")
        #expect(last["type"] as? String == "response")
        // A wrong token, then an immediate retry, is token_throttled.
        await tokenAuth(g, session: 4, token: "bad-token-0123456789", peer: "10.0.0.6")
        await g.receive(session: 4, data: request("c-t2", "host.auth.token", #"{"token":"\#(token)"}"#))
        #expect(events("token_throttled").first?[1] == "10.0.0.6")
        #expect((last["error"] as? [String: Any])?["code"] as? String == "auth_failed")
    }

    @Test("9 wrong PINs from different addresses in one IPv6 /64 hit the per-peer lockout")
    func throttleKeyedBySlash64() async {
        let g = gateway()
        func attempt(_ n: Int, _ pinTried: String) async {
            g.opened(session: n, peer: "2001:db8:1:2::\(n)")
            await g.receive(session: n, data: request("c-h", "host.hello", Self.hello))
            await g.receive(session: n, data: request("c-p", "host.auth.pair", #"{"pin":"\#(pinTried)"}"#))
            g.closed(session: n)
            clock = clock.addingTimeInterval(200)   // past every escalating delay (cap 120 s)
        }
        for n in 1...8 { await attempt(n, "000000") }
        #expect(events("pair_failed").count == 8)
        await attempt(9, "000000")
        #expect(lastError?["message"] as? String == "Too many wrong PINs — locked out for 15 minutes.")
        #expect(events("pair_throttled").last.map { [$0[1], $0[3], $0[4]] } == ["2001:db8:1:2::9", "lockedOut", "2001:db8:1:2::/64"])
        // Even the right PIN from another address in the same /64 is refused.
        await attempt(10, pin)
        #expect(lastError?["message"] as? String == "Too many wrong PINs — locked out for 15 minutes.")
        #expect(store.all.isEmpty)
    }

    // MARK: - Pre-auth slots (ruling 4)

    @Test("pre-auth: a peer (IPv6 /64) holds at most 2 unauthenticated sessions; a third is busy and closed")
    func preAuthCap() async {
        let g = gateway()
        g.opened(session: 1, peer: "fe80::1%en0")
        g.opened(session: 2, peer: "fe80::2")
        g.opened(session: 3, peer: "FE80:0000::3")
        #expect(closed == [3])
        #expect(lastError?["code"] as? String == "busy" && lastError?["retryable"] as? Bool == true)
        #expect(lastError?["message"] as? String == "This device already has connections waiting to sign in — finish or close one first.")
        g.opened(session: 4, peer: "10.0.0.1")   // another peer still gets a slot
        #expect(closed == [3])
        // Once one authenticates, the peer has a pre-auth slot again.
        await g.receive(session: 1, data: request("c-h", "host.hello", Self.hello))
        await g.receive(session: 1, data: request("c-p", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
        g.opened(session: 5, peer: "fe80::5")
        #expect(closed == [3])
    }

    // MARK: - v2 tokens on v1 (ruling 6)

    @Test("a v2-issued token that authenticates on v1 gets only the legacy scopes, never tool_approvals")
    func v2TokenOnV1() async throws {
        toolApprovals = true
        let token = store.issueToken(deviceId: "phone-v2", name: "iPhone")
        let g = gateway()
        await tokenAuth(g, session: 1, token: token)
        let caps = try #require((last["result"] as? [String: Any])?["capabilities"] as? [String])
        #expect(Set(caps) == ["host", "chat", "approvals"])
        await g.receive(session: 1, data: request("c-x", "toolApprovals.answer", #"{"commandId":"s","requestId":"r","decision":"allow_once"}"#))
        #expect(lastError?["code"] as? String == "denied")
    }

    // MARK: - 6-7. Audit log

    @Test("de-dup: 10 pair_throttled for one peer within 60 s give 1 row; one more at t=61 s gives a second")
    func dedupe() {
        let log = HostApiV1AuditLog(fileURL: Self.tempURL())
        let t0 = Date(timeIntervalSince1970: 0)
        for i in 0..<10 { log.record("pair_throttled", peer: "10.0.0.1", detail: "wait", dedupeKey: "10.0.0.1", now: t0.addingTimeInterval(Double(i))) }
        #expect(log.recent(limit: 100).count == 1)
        log.record("pair_throttled", peer: "10.0.0.1", detail: "wait", dedupeKey: "10.0.0.1", now: t0.addingTimeInterval(61))
        #expect(log.recent(limit: 100).count == 2)
    }

    @Test("flood: every refusal from a different Origin writes at most one row per peer and never past the per-event cap")
    func originFlood() {
        let log = HostApiV1AuditLog(fileURL: Self.tempURL())
        for i in 0..<500 {
            MobileControlManager.auditListenerRefusal(log, event: "origin_refused", peer: "-", detail: "https://evil\(i).example")
        }
        #expect(log.recent(limit: 1000).count == 1)
        // Distinct peers (or keys) are still bounded by the per-event cap.
        let capped = HostApiV1AuditLog(fileURL: Self.tempURL())
        let t0 = Date(timeIntervalSince1970: 0)
        for i in 0..<500 { capped.record("origin_refused", peer: "10.0.\(i / 250).\(i % 250)", dedupeKey: "k\(i)", now: t0) }
        #expect(capped.recent(limit: 1000).count == HostApiV1AuditLog.eventCapPerMinute)
        #expect(capped.droppedCount == 500 - HostApiV1AuditLog.eventCapPerMinute)
        // Another event type has its own budget, and the window reopens after a minute.
        capped.record("pair_failed", peer: "10.0.0.1", now: t0)
        capped.record("origin_refused", peer: "10.9.9.9", dedupeKey: "late", now: t0.addingTimeInterval(60))
        let rows = capped.recent(limit: 1000)
        #expect(rows.count == HostApiV1AuditLog.eventCapPerMinute + 3)
        let summary = rows.first { $0.event == "origin_refused_suppressed" }
        #expect(summary?.detail == "440 more origin_refused rows dropped in one minute" && summary?.peer == "-")
    }

    @Test("peerKey matches the desktop: IPv4-mapped to IPv4, IPv6 to /64, IPv4 unchanged")
    func peerKey() {
        #expect(PairingThrottle.peerKey("::ffff:192.168.1.20") == "192.168.1.20")
        #expect(PairingThrottle.peerKey("::FFFF:10.0.0.1%en0") == "10.0.0.1")
        #expect(PairingThrottle.peerKey("2001:db8:1:2::99") == "2001:db8:1:2::/64")
        #expect(PairingThrottle.peerKey("10.0.0.1") == "10.0.0.1")
    }

    @Test("the listener refusal is de-duplicated by peer /64, not by the detail")
    func refusalByPeer() {
        let log = HostApiV1AuditLog(fileURL: Self.tempURL())
        MobileControlManager.auditListenerRefusal(log, event: "plaintext_refused", peer: "2001:db8:1:2::1", detail: "")
        MobileControlManager.auditListenerRefusal(log, event: "plaintext_refused", peer: "2001:db8:1:2::99", detail: "")
        MobileControlManager.auditListenerRefusal(log, event: "plaintext_refused", peer: "2001:db8:1:3::1", detail: "")
        #expect(log.recent(limit: 10).map(\.peer) == ["2001:db8:1:2::1", "2001:db8:1:3::1"])
        #expect(log.recent(limit: 10).allSatisfy { $0.detail == nil })
    }

    @Test("file: rows survive a new log on the same URL, mode 0600, detail clamped, rotated to .1 past maxBytes")
    func file() throws {
        let url = Self.tempURL()
        var echoed: [String] = []
        let lock = NSLock()
        let log = HostApiV1AuditLog(fileURL: url, maxBytes: 1024, echo: { l in lock.lock(); echoed.append(l); lock.unlock() })
        log.record("pair_failed", peer: "10.0.0.1", detail: String(repeating: "x", count: 500))
        #expect(log.recent(limit: 10).first?.detail?.count == 200)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
        #expect(HostApiV1AuditLog(fileURL: url).recent(limit: 10).first?.event == "pair_failed")
        lock.lock(); let line = echoed.first; lock.unlock()
        #expect(line == "Host API v1 audit pair_failed from 10.0.0.1")
        for i in 0..<20 { log.record("pair_failed", peer: "10.0.0.\(i)", detail: String(repeating: "y", count: 100)) }
        _ = log.recent(limit: 1)
        let rotated = url.appendingPathExtension("1")
        #expect(FileManager.default.fileExists(atPath: rotated.path))
        let size = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int ?? .max
        #expect(size < 1024)
        #expect(HostApiV1AuditLog.defaultFileURL().path.hasSuffix("Application Support/llm-ide/host-api-audit.jsonl"))
    }

    // MARK: - Host-side events

    @Test("Reset security identity writes revoke_host for each v1 device and identity_reset; v2 revokes are not audited")
    func hostEvents() throws {
        let url = Self.tempURL()
        let log = HostApiV1AuditLog(fileURL: url)
        let devices = MobilePairedDeviceStore(fileURL: Self.tempURL().deletingLastPathComponent().appendingPathComponent("d.json"))
        _ = devices.issueToken(deviceId: "h1-one", name: "web", scopes: ["host"])
        _ = devices.issueToken(deviceId: "phone-v2", name: "iPhone")
        let manager = MobileControlManager(pairedDeviceStore: devices, hostApiAudit: log)
        manager.revokeDevice("phone-v2")
        manager.resetHostApiIdentity()
        let rows = log.recent(limit: 10)
        #expect(rows.map(\.event) == ["revoke_host", "identity_reset"])
        #expect(rows.first?.deviceId == "h1-one")
    }

    // MARK: - Stopped gateway (Task 5 review minor 2)

    @Test("events still buffered after closeAll never open a session, pair, mint a token or rotate the PIN")
    func stoppedGatewayIgnoresEvents() async {
        let g = gateway()
        g.closeAll()
        g.opened(session: 1, peer: "10.0.0.1")
        await g.receive(session: 1, data: request("c-h", "host.hello", Self.hello))
        await g.receive(session: 1, data: request("c-p", "host.auth.pair", #"{"pin":"\#(pin)"}"#))
        #expect(store.all.isEmpty)
        #expect(sent.isEmpty && closed == [1])
        #expect(events("pair_ok").isEmpty)
    }

    @Test("identity isMissing follows the Keychain item: absent, created, reset")
    func identityMissing() throws {
        let backend = InMemoryKeychainAccess()
        #expect(HostApiV1Identity.isMissing(backend: backend))
        _ = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: backend)
        #expect(!HostApiV1Identity.isMissing(backend: backend))
        HostApiV1Identity.reset(backend: backend)
        #expect(HostApiV1Identity.isMissing(backend: backend))
    }

    // MARK: - Listener

    @Test("the plaintext listener honours only loopback http:// origins, never https://")
    func devOrigins() {
        let list = ["http://localhost:5173", "https://app.example.com", "http://[::1]:8080"]
        #expect(HostApiV1Origins.forTransport(list, tls: false) == ["http://localhost:5173", "http://[::1]:8080"])
        #expect(HostApiV1Origins.forTransport(list, tls: true) == list)
    }

    @Test("a handshake refused for its Origin never opens a gateway session")
    func refusedOriginNeverOpens() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let frames = FrameBox(), events = EventBox()
        let listener = HostApiV1TLSListenerTests.tlsListener(id, frames: frames, events: events, allowlist: ["https://app.example.com"])
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let q = DispatchQueue(label: "t.origin.slot")
        let bad = HostApiV1TLSListenerTests.pinnedClient(port: bound, fingerprint: id.fingerprint, queue: q, headers: [("Origin", "https://evil.example")])
        defer { bad.cancel() }
        #expect(await HostApiV1TLSListenerTests.connect(bad, queue: q) == false)
        try await Task.sleep(nanoseconds: 500_000_000)
        #expect(events.openCount == 0)
        #expect(events.refusals.contains { $0[0] == "origin_refused" })
    }

    @Test("a connected client that sends nothing is closed at the deadline with handshake_timeout")
    func silentClientClosed() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let frames = FrameBox(), events = EventBox()
        let listener = HostApiV1TLSListenerTests.tlsListener(id, frames: frames, events: events, handshakeTimeout: 1)
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let q = DispatchQueue(label: "t.silent")
        let conn = HostApiV1TLSListenerTests.pinnedClient(port: bound, fingerprint: id.fingerprint, queue: q)
        defer { conn.cancel() }
        #expect(await HostApiV1TLSListenerTests.connect(conn, queue: q))
        try await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(events.openCount == 0)
        #expect(events.refusals.contains { $0[0] == "handshake_timeout" && $0[1] != "-" })
    }

    @Test("a peer that stops reading is closed once 4 MiB are in flight")
    func backpressure() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let frames = FrameBox()
        let closes = EventBox()
        let listener = HostApiV1Listener(basePort: HostApiV1TLSListenerTests.port(), candidates: 5, transport: .tls(id.identity),
                                         originAllowlist: [], onRefused: { _, _, _ in },
                                         onOpen: { _, _ in }, onFrame: { s, d in frames.add(s, d) },
                                         onClose: { _ in closes.opened() }, onListening: { frames.bound($0) }, onLog: { _ in })
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let q = DispatchQueue(label: "t.backpressure")
        let conn = HostApiV1TLSListenerTests.pinnedClient(port: bound, fingerprint: id.fingerprint, queue: q)
        defer { conn.cancel() }
        #expect(await HostApiV1TLSListenerTests.connect(conn, queue: q))
        HostApiV1TLSListenerTests.sendText(conn, HostApiV1TLSListenerTests.ping)
        _ = try await frames.waitForFrame()
        // The client never reads; 32 MiB queued must trip the cap instead of buffering it all.
        let big = Data(repeating: 0x61, count: 512 * 1024)
        for _ in 0..<64 { listener.send(1, big) }
        for _ in 0..<100 where closes.openCount == 0 { try await Task.sleep(nanoseconds: 50_000_000) }
        #expect(closes.openCount == 1)
    }
}
