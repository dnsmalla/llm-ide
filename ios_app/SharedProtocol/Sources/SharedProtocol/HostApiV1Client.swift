import Foundation

/// Host API v1 over one WebSocket (spec "Handshake", "Reconnect after iOS suspends"). It owns hello, auth,
/// request correlation, a ping watchdog and `rev`-gap detection. It has no reconnect loop: the app's
/// existing backoff calls `connect` again with the token. The owner must call `close()` when done; a client
/// released without it still cancels its socket in `deinit`, but its owner gets no event.
@MainActor
public final class HostApiV1Client: HostConnection {
    public struct Config: Sendable {
        public var clientName: String
        public var clientVersion: String
        public var helloTimeout: TimeInterval
        public var requestTimeout: TimeInterval
        public var pingInterval: TimeInterval
        public init(clientName: String, clientVersion: String, helloTimeout: TimeInterval = 3,
                    requestTimeout: TimeInterval = 15, pingInterval: TimeInterval = 10) {
            self.clientName = clientName; self.clientVersion = clientVersion
            self.helloTimeout = helloTimeout; self.requestTimeout = requestTimeout; self.pingInterval = pingInterval
        }
    }

    public enum ConnectOutcome: Sendable, Equatable {
        /// Authenticated. `token` is set when this connect paired with a PIN; the caller must store it.
        case ready(hello: HostApiHostHelloResult, token: String?)
        /// No v1 host answered (silence, or another API version): back off and retry.
        case unreachable
        /// A v1 host refused: bad PIN, revoked token, throttle, busy.
        case refused(HostApiRejection)
    }

    public let apiVersion = 1
    public private(set) var state: HostConnectionState = .disconnected
    public private(set) var capabilities: Set<String> = []
    public var onEvent: ((HostEvent) -> Void)?

    private let config: Config
    private let makeSocket: () -> HostApiSocket
    private var socket: HostApiSocket?
    private var pending: [String: (command: HostApiCommand, seq: Int, continuation: CheckedContinuation<Data, Error>)] = [:]
    private var seq = 0
    private var revs = HostApiRevTracker()
    private var generation = 0
    private var readTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?

    /// No reply in time, or the socket failed. It never leaves the client: `send` turns it into `host_unreachable`.
    private struct Silence: Error {}

    // A deinit is nonisolated by default; spelling it `nonisolated` needs Swift 6.2+ (CI's Xcode is older).
    deinit {
        readTask?.cancel()
        pingTask?.cancel()
        socket?.cancel()
    }

    public init(config: Config, makeSocket: @escaping () -> HostApiSocket) {
        self.config = config
        self.makeSocket = makeSocket
    }

    public func connect(_ credential: HostCredential) async -> ConnectOutcome {
        teardown()
        let gen = generation
        let s = makeSocket()
        socket = s
        state = .connecting
        startReading(s, generation: gen)
        var negotiation = HostApiNegotiation()
        _ = negotiation.handle(.start(v1Endpoint: true))

        let hello: HostApiHostHelloResult
        do {
            let request = HostApiHostHelloRequest(
                apiVersions: [HostApi.version],
                clientName: HostApiFrame.clamp(config.clientName.isEmpty ? "iPhone" : config.clientName, maxUTF16: 120),
                clientVersion: HostApiFrame.clamp(config.clientVersion.isEmpty ? "0" : config.clientVersion, maxUTF16: 64),
                platform: "ios")
            hello = try JSONDecoder().decode(HostApiHostHelloResult.self,
                                             from: try await self.request(.hostHello, request, timeout: config.helloTimeout))
        } catch let r as HostApiRejection {
            return finish(negotiation.handle(.helloRefused(r)), gen)
        } catch {
            return finish(negotiation.handle(.silent), gen)
        }
        capabilities = Set(hello.capabilities)
        switch negotiation.handle(.helloAnswered(apiVersion: hello.apiVersion, requiresAuth: hello.requiresAuth)) {
        case .sendAuth: break
        case .ready: return ready(hello, token: nil, gen)
        case let other: return finish(other, gen)
        }
        do {
            switch credential {
            case .pin(let pin):
                let r = try JSONDecoder().decode(HostApiHostAuthPairResult.self, from: try await request(
                    .hostAuthPair, HostApiHostAuthPairRequest(pin: pin), timeout: config.requestTimeout))
                capabilities = Set(r.capabilities)
                _ = negotiation.handle(.authAnswered)
                return ready(hello, token: r.token, gen)
            case .token(let token):
                let r = try JSONDecoder().decode(HostApiHostAuthTokenResult.self, from: try await request(
                    .hostAuthToken, HostApiHostAuthTokenRequest(token: token), timeout: config.requestTimeout))
                capabilities = Set(r.capabilities)
                _ = negotiation.handle(.authAnswered)
                return ready(hello, token: nil, gen)
            }
        } catch let r as HostApiRejection {
            return finish(negotiation.handle(.authRefused(r)), gen)
        } catch {
            return finish(negotiation.handle(.silent), gen)
        }
    }

    public func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        guard state == .connected else {
            throw HostApiRejection(replyTo: id, code: "host_unreachable", message: "Not connected to the host.", retryable: true)
        }
        let value = try JSONDecoder().decode(HostApiJSONValue.self, from: payload)
        do {
            return try await request(command, value, id: id, timeout: config.requestTimeout)
        } catch is Silence {
            // Spec "Wire envelope": only an idempotent command may be retried with the same id.
            throw HostApiRejection(replyTo: id, code: "host_unreachable", message: "The host did not answer in time.",
                                   retryable: command.idempotent)
        }
    }

    /// Silent: the caller chose to close and needs no event.
    public func close() { teardown() }

    // MARK: - Internals

    /// A Config value as a sleep: NaN or negative takes `default`, anything over a day is a day, so
    /// `UInt64(_:)` can never trap.
    private nonisolated static func nanoseconds(_ seconds: TimeInterval, default fallback: TimeInterval) -> UInt64 {
        let s = seconds.isNaN || seconds < 0 ? fallback : min(seconds, 86_400)
        return UInt64(s * 1_000_000_000)
    }

    private func ready(_ hello: HostApiHostHelloResult, token: String?, _ gen: Int) -> ConnectOutcome {
        guard gen == generation, socket != nil else { return Self.superseded }
        state = .connected
        startPing(generation: gen)
        return .ready(hello: hello, token: token)
    }

    private static let superseded = ConnectOutcome.refused(.init(
        replyTo: nil, code: "host_unreachable", message: "The connection closed while signing in.", retryable: true))

    private func finish(_ action: HostApiNegotiation.Action, _ gen: Int) -> ConnectOutcome {
        // A newer connect (or close) owns the client now: never tear its socket down.
        guard gen == generation else { return Self.superseded }
        teardown()
        switch action {
        case .unreachable: return .unreachable
        case .fail(let r): return .refused(r)
        default: return .refused(.init(replyTo: nil, code: "internal", message: "Host API negotiation reached an unexpected step."))
        }
    }

    private func teardown() {
        generation += 1
        readTask?.cancel(); readTask = nil
        pingTask?.cancel(); pingTask = nil
        socket?.cancel(); socket = nil
        let waiting = pending
        pending.removeAll()
        for (_, p) in waiting { p.continuation.resume(throwing: Silence()) }
        revs.reset()
        capabilities = []
        state = .disconnected
    }

    private func request<P: Encodable>(_ command: HostApiCommand, _ payload: P, id: String? = nil,
                                       timeout: TimeInterval) async throws -> Data {
        guard let socket else { throw Silence() }
        let id = id ?? HostApiFrame.newClientId()
        guard pending[id] == nil else {
            throw HostApiRejection(replyTo: id, code: "busy", message: "That request id is still waiting for a reply.")
        }
        let frame = String(decoding: try HostApiFrame.request(id: id, command: command, payload: payload), as: UTF8.self)
        let gen = generation
        seq += 1
        let mine = seq
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = (command, mine, continuation)
            Task { [weak self] in
                do { try await socket.send(frame) } catch {
                    self?.resolve(id, mine, gen, throwing: (error as? HostApiRejection) ?? Silence())
                }
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.nanoseconds(timeout, default: 15))
                self?.resolve(id, mine, gen, throwing: Silence())
            }
        }
    }

    /// `seq` keeps an answered request's timer off a later request that reuses its id.
    private func resolve(_ id: String, _ seq: Int, _ gen: Int, throwing error: Error) {
        guard gen == generation, pending[id]?.seq == seq else { return }
        pending.removeValue(forKey: id)?.continuation.resume(throwing: error)
    }

    private func startReading(_ s: HostApiSocket, generation gen: Int) {
        readTask = Task { [weak self] in
            while true {
                let data: Data
                do { data = try await s.receive() } catch { self?.socketEnded(gen, error as? HostApiRejection); return }
                guard let self, gen == self.generation else { return }
                self.handle(data)
            }
        }
    }

    private func startPing(generation gen: Int) {
        pingTask = Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: Self.nanoseconds(self?.config.pingInterval ?? 10, default: 10))
                guard let self, gen == self.generation, !Task.isCancelled else { return }
                do { _ = try await self.request(.hostPing, HostApiHostPingRequest(), timeout: self.config.requestTimeout) }
                catch is Silence { self.socketEnded(gen); return }
                catch { /* a refusal still proves the host is alive */ }
            }
        }
    }

    /// `reason` is the socket's own refusal (a pin mismatch); without one the socket just went away.
    private func socketEnded(_ gen: Int, _ reason: HostApiRejection? = nil) {
        guard gen == generation else { return }
        guard state == .connected else {
            // connect is awaiting a reply: fail it, and connect decides (unreachable or refusal) and tears down.
            let waiting = pending
            pending.removeAll()
            for (_, p) in waiting { p.continuation.resume(throwing: reason ?? Silence()) }
            return
        }
        teardown()
        onEvent?(.disconnected(reason: reason ?? .init(replyTo: nil, code: "host_unreachable",
                                                       message: "The connection to the host was lost.", retryable: true)))
    }

    private func handle(_ data: Data) {
        guard case .success(let frame) = HostApiFrame.parseInbound(data) else { return }
        switch frame {
        case let .response(replyTo, command, result, rev):
            revs.baseline(rev)
            guard let p = pending.removeValue(forKey: replyTo) else { return }
            if p.command == command {
                p.continuation.resume(returning: result)
            } else {
                p.continuation.resume(throwing: HostApiRejection(replyTo: replyTo, code: "internal",
                    message: "The host answered \(p.command.rawValue) with \(command.rawValue)."))
            }
        case let .error(replyTo, rejection, rev):
            if let rev { revs.baseline(rev) }
            if let replyTo, let p = pending.removeValue(forKey: replyTo) {
                p.continuation.resume(throwing: rejection)
            } else if rejection.code == "auth_failed" || state != .connected {
                // Unsolicited: the device was removed on the host, or the host refused the connection
                // (busy) before answering. Every waiter gets the host's reason, not a timeout.
                let wasConnected = state == .connected
                let waiting = pending
                pending.removeAll()
                for (_, p) in waiting { p.continuation.resume(throwing: rejection) }
                if wasConnected { teardown(); onEvent?(.disconnected(reason: rejection)) }
            }
        case let .event(name, payload, replyTo, rev):
            if revs.observe(event: rev) == .gap { onEvent?(.resync) }
            if name == .hostCapabilities,
               let e = try? JSONDecoder().decode(HostApiHostCapabilitiesEvent.self, from: payload) {
                capabilities = Set(e.capabilities)
                onEvent?(.capabilities(capabilities))
            }
            onEvent?(.event(name, payload: payload, replyTo: replyTo))
        }
    }
}
