import Testing
import Foundation
import Network
import Security
@testable import LlmIdeMacLib

@Suite("HostApiV1 TLS listener", .serialized)
struct HostApiV1TLSListenerTests {
    /// A pinned v1 test client: TLS whose verify block accepts ONLY the expected SPKI fingerprint, WebSocket on top.
    static func pinnedClient(port: Int, fingerprint: String, queue: DispatchQueue, headers: [(name: String, value: String)] = []) -> NWConnection {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let t = sec_trust_copy_ref(trust).takeRetainedValue()
            guard let chain = SecTrustCopyCertificateChain(t) as? [SecCertificate], let leaf = chain.first,
                  let fp = HostApiV1Identity.fingerprint(certificate: leaf) else { return complete(false) }
            complete(fp == fingerprint)
        }, queue)
        let params = NWParameters(tls: tls)
        let ws = NWProtocolWebSocket.Options()
        if !headers.isEmpty { ws.setAdditionalHeaders(headers) }
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        // A URL endpoint, not .hostPort: the WebSocket client over TLS aborts (ECONNABORTED) without one.
        return NWConnection(to: .url(URL(string: "wss://127.0.0.1:\(port)")!), using: params)
    }

    /// Starts the client and resolves to true on `.ready`, false on `.failed`/`.waiting`/`.cancelled` (or after 5 s).
    static func connect(_ conn: NWConnection, queue: DispatchQueue) async -> Bool {
        let once = Once()
        return await withCheckedContinuation { (k: CheckedContinuation<Bool, Never>) in
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: if once.fire() { k.resume(returning: true) }
                case .failed, .waiting, .cancelled: if once.fire() { k.resume(returning: false) }
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 5) { if once.fire() { k.resume(returning: false) } }
        }
    }

    static func sendText(_ conn: NWConnection, _ text: String) {
        let ctx = NWConnection.ContentContext(identifier: "t", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        conn.send(content: Data(text.utf8), contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
    }

    static let ping = #"{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1}"#
    static func port() -> Int { 3016 + Int.random(in: 1000...1900) }

    static func tlsListener(_ id: HostApiV1Identity.Loaded, frames: FrameBox, events: EventBox, allowlist: [String] = []) -> HostApiV1Listener {
        HostApiV1Listener(basePort: port(), candidates: 5, transport: .tls(id.identity), originAllowlist: allowlist,
                          onRefused: { e, p, d in events.refused(e, p, d) },
                          onOpen: { _, _ in events.opened() }, onFrame: { s, d in frames.add(s, d) }, onClose: { _ in },
                          onListening: { frames.bound($0) }, onLog: { _ in })
    }

    @Test("mode: TLS by env or default (even without DEBUG), dev needs flag + DEBUG, else off; TLS wins")
    func mode() throws {
        let suite = "h6-test-\(UUID())"
        let d = try #require(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        #expect(HostApiV1Listener.mode(environment: [:], defaults: d, isDebugBuild: true) == .off)
        #expect(HostApiV1Listener.mode(environment: ["LLMIDE_HOST_API_TLS": "1"], defaults: d, isDebugBuild: false) == .tls)
        #expect(HostApiV1Listener.mode(environment: ["LLMIDE_HOST_API_DEV": "1"], defaults: d, isDebugBuild: true) == .devPlaintext)
        #expect(HostApiV1Listener.mode(environment: ["LLMIDE_HOST_API_DEV": "1"], defaults: d, isDebugBuild: false) == .off)
        #expect(HostApiV1Listener.mode(environment: ["LLMIDE_HOST_API_DEV": "1", "LLMIDE_HOST_API_TLS": "1"], defaults: d, isDebugBuild: true) == .tls)
        d.set(true, forKey: "HostApiV1.tlsEnabled")
        #expect(HostApiV1Listener.mode(environment: [:], defaults: d, isDebugBuild: false) == .tls)
        #expect(HostApiV1Listener.mode(environment: ["LLMIDE_HOST_API_DEV": "1"], defaults: d, isDebugBuild: true) == .tls)
    }

    @Test("a pinned client with the right fingerprint connects and its frame reaches the gateway")
    func pinnedConnects() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let frames = FrameBox(), events = EventBox()
        let listener = Self.tlsListener(id, frames: frames, events: events)
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let q = DispatchQueue(label: "t.pinned")
        let conn = Self.pinnedClient(port: bound, fingerprint: id.fingerprint, queue: q)
        defer { conn.cancel() }
        #expect(await Self.connect(conn, queue: q))
        Self.sendText(conn, Self.ping)
        let got = try await frames.waitForFrame()
        #expect(String(decoding: got, as: UTF8.self).contains("host.ping"))
    }

    @Test("a client pinned to another fingerprint is refused before any frame")
    func pinMismatch() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let other = try HostApiV1Identity.loadOrCreate(hostName: "Other", backend: InMemoryKeychainAccess())
        #expect(other.fingerprint != id.fingerprint)
        let frames = FrameBox(), events = EventBox()
        let listener = Self.tlsListener(id, frames: frames, events: events)
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let q = DispatchQueue(label: "t.mismatch")
        let conn = Self.pinnedClient(port: bound, fingerprint: other.fingerprint, queue: q)
        defer { conn.cancel() }
        #expect(await Self.connect(conn, queue: q) == false)
        try await Task.sleep(nanoseconds: 2_000_000_000)
        #expect(events.openCount == 0)
        #expect(frames.count == 0)
    }

    @Test("plaintext to the TLS port is refused")
    func plaintextRefused() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let frames = FrameBox(), events = EventBox()
        let listener = Self.tlsListener(id, frames: frames, events: events)
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3   // the TLS side drops the plaintext request; don't wait the 60 s default
        let task = URLSession(configuration: config).webSocketTask(with: URL(string: "ws://127.0.0.1:\(bound)")!)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }
        await #expect(throws: (any Error).self) { _ = try await task.receive() }
        #expect(events.openCount == 0)
        #expect(frames.count == 0)
    }

    @Test("a listed Origin is accepted and an unlisted one refused, with origin_refused reported")
    func originAllowlist() async throws {
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let frames = FrameBox(), events = EventBox()
        let listener = Self.tlsListener(id, frames: frames, events: events, allowlist: ["https://app.example.com"])
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let q = DispatchQueue(label: "t.origin")

        let good = Self.pinnedClient(port: bound, fingerprint: id.fingerprint, queue: q, headers: [("Origin", "https://app.example.com")])
        defer { good.cancel() }
        #expect(await Self.connect(good, queue: q))
        Self.sendText(good, Self.ping)
        _ = try await frames.waitForFrame()

        let bad = Self.pinnedClient(port: bound, fingerprint: id.fingerprint, queue: q, headers: [("Origin", "https://evil.example")])
        defer { bad.cancel() }
        #expect(await Self.connect(bad, queue: q) == false)
        #expect(events.refusals.contains { $0 == ["origin_refused", "-", "https://evil.example"] })
        // Network.framework still moves a rejected server connection to .ready, then cancels it, so onOpen
        // may fire for it; what matters is that it never carries a frame.
        #expect(frames.count == 1)
    }

    @Test("the dev plaintext listener still binds loopback only")
    func devLoopbackOnly() async throws {
        let p = NWEndpoint.Port(rawValue: 3016)!
        let dev = HostApiV1Listener.parameters(for: .devPlaintext, port: p, ws: NWProtocolWebSocket.Options())
        #expect(dev.requiredLocalEndpoint == .hostPort(host: .ipv4(.loopback), port: p))
        let id = try HostApiV1Identity.loadOrCreate(hostName: "Mac", backend: InMemoryKeychainAccess())
        let tls = HostApiV1Listener.parameters(for: .tls(id.identity), port: p, ws: NWProtocolWebSocket.Options())
        #expect(tls.requiredLocalEndpoint == nil)
        try await HostApiV1ListenerTests().loopbackRoundTrip()
    }
}

final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func fire() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var opens = 0
    private var refused: [[String]] = []
    func opened() { lock.lock(); opens += 1; lock.unlock() }
    func refused(_ e: String, _ p: String, _ d: String) { lock.lock(); refused.append([e, p, d]); lock.unlock() }
    var openCount: Int { lock.lock(); defer { lock.unlock() }; return opens }
    var refusals: [[String]] { lock.lock(); defer { lock.unlock() }; return refused }
}

