import Testing
import Foundation
import SharedProtocol

/// A scripted host. `reply` answers each request the client sends; a test can also push frames or kill the socket.
final class FakeHostSocket: HostApiSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var _sent: [[String: Any]] = []
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private var iterator: AsyncThrowingStream<Data, Error>.AsyncIterator
    var reply: (_ command: String, _ id: String) -> [Data] = { _, _ in [] }

    init() {
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        self.continuation = continuation
        self.iterator = stream.makeAsyncIterator()
    }
    var sentCommands: [String] { lock.withLock { _sent.compactMap { $0["command"] as? String } } }
    var sent: [[String: Any]] { lock.withLock { _sent } }

    func send(_ text: String) async throws {
        let obj = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        lock.withLock { _sent.append(obj) }
        for frame in reply(obj["command"] as! String, obj["id"] as! String) { continuation.yield(frame) }
    }
    func receive() async throws -> Data {
        var it = iterator   // the iterator is reference-backed; copying keeps exclusivity simple
        defer { iterator = it }
        guard let next = try await it.next() else { throw URLError(.networkConnectionLost) }
        return next
    }
    func push(_ frame: Data) { continuation.yield(frame) }
    func fail() { continuation.finish(throwing: URLError(.networkConnectionLost)) }
    private var _cancelled = false
    var cancelled: Bool { lock.withLock { _cancelled } }
    func cancel() { lock.withLock { _cancelled = true }; continuation.finish() }
}

@MainActor
@Suite("HostApiV1Client")
struct HostApiV1ClientTests {
    static let hello = HostApiHostHelloResult(apiVersion: 1, apiVersions: [1], capabilities: ["host", "chat", "approvals"],
                                              hostKind: "mac", hostName: "Test Mac", protocolVersion: 3, requiresAuth: true)
    static let token = String(repeating: "t", count: 32)
    let socket = FakeHostSocket()

    func client(helloTimeout: TimeInterval = 0.2, requestTimeout: TimeInterval = 0.3) -> HostApiV1Client {
        HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", helloTimeout: helloTimeout,
                                      requestTimeout: requestTimeout, pingInterval: 60),
                        makeSocket: { [socket] in socket })
    }

    /// A v1 host that answers hello and both auth commands at `rev`.
    func happyHost(rev: Int = 0, caps: [String] = ["host", "chat", "approvals"]) {
        socket.reply = { command, id in
            switch command {
            case "host.hello": return [try! HostApiFrame.response(replyTo: id, command: .hostHello, result: Self.hello, rev: rev)]
            case "host.auth.pair": return [try! HostApiFrame.response(replyTo: id, command: .hostAuthPair,
                                           result: HostApiHostAuthPairResult(capabilities: caps, token: Self.token), rev: rev)]
            case "host.auth.token": return [try! HostApiFrame.response(replyTo: id, command: .hostAuthToken,
                                            result: HostApiHostAuthTokenResult(capabilities: caps), rev: rev)]
            default: return []
            }
        }
    }

    @Test("PIN connect: hello then pair, returns the new token, granted capabilities win")
    func pinConnect() async {
        happyHost(caps: ["host", "chat"])
        let c = client()
        let outcome = await c.connect(.pin("123456"))
        #expect(outcome == .ready(hello: Self.hello, token: Self.token))
        #expect(c.state == .connected)
        #expect(c.capabilities == ["host", "chat"])
        #expect(socket.sentCommands == ["host.hello", "host.auth.pair"])
        let hello = socket.sent[0]["payload"] as? [String: Any]
        #expect(hello?["platform"] as? String == "ios")
        #expect(hello?["apiVersions"] as? [Int] == [1])
    }

    @Test("token connect never sends the PIN and returns no new token")
    func tokenConnect() async {
        happyHost()
        let outcome = await client().connect(.token(Self.token))
        #expect(outcome == .ready(hello: Self.hello, token: nil))
        #expect(socket.sentCommands == ["host.hello", "host.auth.token"])
    }

    @Test("no answer to hello is unreachable; so is a version refusal")
    func unreachable() async {
        let silent = await client().connect(.pin("123456"))
        #expect(silent == .unreachable)

        socket.reply = { _, id in [HostApiFrame.error(replyTo: id, code: "capability_unavailable", message: "v1 only", retryable: false, rev: 0)] }
        #expect(await client().connect(.pin("123456")) == .unreachable)
    }

    @Test("a v1 auth refusal is final, with the host's code and retryability")
    func refused() async {
        socket.reply = { command, id in
            command == "host.hello"
                ? [try! HostApiFrame.response(replyTo: id, command: .hostHello, result: Self.hello, rev: 0)]
                : [HostApiFrame.error(replyTo: id, code: "auth_failed", message: "Wrong PIN", retryable: false, rev: 0)]
        }
        guard case .refused(let r) = await client().connect(.pin("123456")) else { Issue.record("expected refused"); return }
        #expect(r.code == "auth_failed"); #expect(!r.retryable)
    }

    @Test("an unsolicited busy before hello is answered is a refusal, not a v2 fallback")
    func busyBeforeHello() async {
        socket.reply = { _, _ in [HostApiFrame.error(replyTo: nil, code: "busy", message: "full", retryable: true, rev: 0)] }
        guard case .refused(let r) = await client().connect(.pin("123456")) else { Issue.record("expected refused"); return }
        #expect(r.code == "busy"); #expect(r.retryable)
    }

    @Test("send correlates by id, surfaces error frames and times out as host_unreachable")
    func sendCorrelation() async throws {
        happyHost()
        let c = client()
        _ = await c.connect(.token(Self.token))
        socket.reply = { command, id in
            switch command {
            case "chat.cancel": return [try! HostApiFrame.response(replyTo: id, command: .chatCancel, result: HostApiChatCancelResult(cancelled: true), rev: 0)]
            case "chat.history.clear": return [HostApiFrame.error(replyTo: id, code: "denied", message: "Off on the Mac", retryable: false, rev: 0)]
            default: return []
            }
        }
        #expect(try await c.send(.chatCancel, HostApiChatCancelRequest(), as: HostApiChatCancelResult.self).cancelled)
        await #expect(throws: HostApiRejection(replyTo: "c-x", code: "denied", message: "Off on the Mac")) {
            _ = try await c.send(.chatHistoryClear, HostApiChatHistoryClearRequest(), id: "c-x", as: HostApiChatHistoryClearResult.self)
        }
        do {
            _ = try await c.send(.chatSend, HostApiChatSendRequest(text: "hi"), id: "c-y", as: HostApiChatSendResult.self)
            Issue.record("expected a timeout")
        } catch let r as HostApiRejection {
            #expect(r.code == "host_unreachable")
            #expect(r.retryable == false, "chat.send is not idempotent")
        }
    }

    @Test("an event rev gap emits resync before the event; capabilities events update the set")
    func revGapAndCapabilities() async throws {
        happyHost(rev: 4)
        let c = client()
        var events: [HostEvent] = []
        c.onEvent = { events.append($0) }
        _ = await c.connect(.token(Self.token))
        socket.push(try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: "a"), rev: 5, replyTo: "c-1"))
        socket.push(try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: "b"), rev: 9, replyTo: "c-1"))
        socket.push(try HostApiFrame.event("host.capabilities", payload: HostApiHostCapabilitiesEvent(capabilities: ["host"]), rev: 10))
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(events.count == 5)
        #expect(events[0] == .event(.chatDelta, payload: try JSONEncoder().encode(HostApiChatDeltaEvent(text: "a")), replyTo: "c-1"))
        #expect(events[1] == .resync)
        #expect(events[3] == .capabilities(["host"]))
        #expect(c.capabilities == ["host"])
    }

    @Test("a socket that dies after connect reports disconnected host_unreachable; an unsolicited auth_failed reports auth_failed")
    func drops() async throws {
        happyHost()
        let c = client()
        var events: [HostEvent] = []
        c.onEvent = { events.append($0) }
        _ = await c.connect(.token(Self.token))
        socket.push(HostApiFrame.error(replyTo: nil, code: "auth_failed", message: "This device was removed on the Mac.", retryable: false, rev: 0))
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .disconnected(let r) = events.last else { Issue.record("expected disconnected"); return }
        #expect(r.code == "auth_failed")
        #expect(c.state == .disconnected)

        let other = FakeHostSocket()
        other.reply = socket.reply
        let d = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", pingInterval: 60), makeSocket: { other })
        var dEvents: [HostEvent] = []
        d.onEvent = { dEvents.append($0) }
        _ = await d.connect(.token(Self.token))
        other.fail()
        try await Task.sleep(nanoseconds: 50_000_000)
        guard case .disconnected(let lost) = dEvents.last else { Issue.record("expected disconnected"); return }
        #expect(lost.code == "host_unreachable"); #expect(lost.retryable)
    }

    @Test("a superseded connect fails without tearing down the connect that replaced it")
    func supersededConnect() async {
        let silent = FakeHostSocket()
        happyHost()
        var sockets: [FakeHostSocket] = [silent, socket]
        let c = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", helloTimeout: 0.2,
                                              requestTimeout: 0.3, pingInterval: 60),
                                makeSocket: { sockets.removeFirst() })
        let first = Task { await c.connect(.token(Self.token)) }
        await Task.yield()
        #expect(await c.connect(.token(Self.token)) == .ready(hello: Self.hello, token: nil))
        guard case .refused(let r) = await first.value else { Issue.record("expected refused"); return }
        #expect(r.code == "host_unreachable")
        #expect(c.state == .connected)
        #expect(silent.sentCommands == ["host.hello"])
    }

    @Test("an answered request's timer never times out a later request that reuses its id")
    func reusedIdTimer() async throws {
        happyHost()
        let c = client(requestTimeout: 0.3)
        _ = await c.connect(.token(Self.token))
        let answer = { (id: String) in try! HostApiFrame.response(replyTo: id, command: .hostPing, result: HostApiHostPingResult(), rev: 0) }
        socket.reply = { _, id in [answer(id)] }
        _ = try await c.send(.hostPing, HostApiHostPingRequest(), id: "c-r", as: HostApiHostPingResult.self)
        try await Task.sleep(nanoseconds: 200_000_000)
        // Answered 0.2 s after the second send: past the first timer (0.3 s), within the second's.
        socket.reply = { [socket] _, id in
            Task { try? await Task.sleep(nanoseconds: 200_000_000); socket.push(answer(id)) }
            return []
        }
        _ = try await c.send(.hostPing, HostApiHostPingRequest(), id: "c-r", as: HostApiHostPingResult.self)
    }

    @Test("a no-auth hello serves its capabilities; teardown never leaves a stale set")
    func capabilitiesFresh() async {
        let open = HostApiHostHelloResult(apiVersion: 1, apiVersions: [1], capabilities: ["host"],
                                          hostKind: "mac", hostName: "Open Mac", protocolVersion: 3, requiresAuth: false)
        socket.reply = { _, id in [try! HostApiFrame.response(replyTo: id, command: .hostHello, result: open, rev: 0)] }
        let c = client()
        #expect(await c.connect(.token(Self.token)) == .ready(hello: open, token: nil))
        #expect(c.capabilities == ["host"])
        #expect(socket.sentCommands == ["host.hello"])
        c.close()
        #expect(c.capabilities.isEmpty)

        // A reconnect that lands on a host with no v1 answer keeps nothing from the last host.
        let first = FakeHostSocket(), other = FakeHostSocket()
        happyHost()
        first.reply = socket.reply
        var sockets: [FakeHostSocket] = [first, other]
        let d = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", helloTimeout: 0.2,
                                              requestTimeout: 0.3, pingInterval: 60),
                                makeSocket: { sockets.removeFirst() })
        _ = await d.connect(.token(Self.token))
        #expect(d.capabilities == ["host", "chat", "approvals"])
        #expect(await d.connect(.token(Self.token)) == .unreachable)
        #expect(d.capabilities.isEmpty)
    }

    @Test("an unanswered host.ping drops the connection as host_unreachable and closes the socket")
    func pingWatchdog() async throws {
        happyHost()
        let c = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", helloTimeout: 0.2,
                                              requestTimeout: 0.1, pingInterval: 0.05),
                                makeSocket: { [socket] in socket })
        var events: [HostEvent] = []
        c.onEvent = { events.append($0) }
        #expect(await c.connect(.token(Self.token)) == .ready(hello: Self.hello, token: nil))
        try await Task.sleep(nanoseconds: 400_000_000)
        #expect(socket.sentCommands.contains("host.ping"))
        guard case .disconnected(let r) = events.last else { Issue.record("expected disconnected"); return }
        #expect(r.code == "host_unreachable"); #expect(r.retryable)
        #expect(c.state == .disconnected)
        #expect(socket.cancelled)
    }

    @Test("negative, NaN and infinite timeouts never trap")
    func badTimeouts() async {
        happyHost()
        let c = HostApiV1Client(config: .init(clientName: "iPhone", clientVersion: "2.0", helloTimeout: -1,
                                              requestTimeout: .nan, pingInterval: .infinity),
                                makeSocket: { [socket] in socket })
        #expect(await c.connect(.token(Self.token)) == .ready(hello: Self.hello, token: nil))
        c.close()
    }

    @Test("releasing a connected client without close() cancels its socket")
    func deinitCancels() async {
        happyHost()
        var c: HostApiV1Client? = client()
        _ = await c?.connect(.token(Self.token))
        c = nil
        #expect(socket.cancelled)
    }

    @Test("send while disconnected throws host_unreachable without touching the socket")
    func sendDisconnected() async {
        await #expect(throws: HostApiRejection.self) {
            _ = try await client().send(.hostPing, HostApiHostPingRequest(), as: HostApiHostPingResult.self)
        }
        #expect(socket.sentCommands.isEmpty)
    }

    @Test("close() during the handshake ends connect at once and cancels the socket (final review I3)")
    func closeDuringHandshake() async {
        let c = client(helloTimeout: 30)   // the host never answers hello
        let started = Date()
        async let outcome = c.connect(.pin("123456"))
        try? await Task.sleep(nanoseconds: 50_000_000)
        c.close()
        guard case .refused(let r) = await outcome else { Issue.record("expected refused"); return }
        #expect(r.code == "host_unreachable")
        #expect(Date().timeIntervalSince(started) < 5)
        #expect(socket.cancelled)
        #expect(c.state == .disconnected)
    }
}
