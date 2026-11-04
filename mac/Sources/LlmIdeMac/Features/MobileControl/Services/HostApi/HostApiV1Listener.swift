import Foundation
import Network
import Security
import SharedProtocol

/// Host API v1 listener, in one of two transports (plan decision 5):
/// - `.tls`: WSS on every interface with the host's pinned self-signed identity (`LLMIDE_HOST_API_TLS=1`
///   or the `HostApiV1.tlsEnabled` default). TLS is what makes a non-loopback peer acceptable.
/// - `.devPlaintext`: plaintext WebSocket on 127.0.0.1 only, in a DEBUG build with `LLMIDE_HOST_API_DEV=1`
///   (spec "Security": plaintext only behind an explicit development flag; production builds refuse it).
/// A handshake whose `Origin` is not on the allowlist (`HostApiV1Origins`) is refused before the socket opens.
/// One ordered stream for a listener's open/frame/close callbacks (they all fire on its serial queue).
enum HostApiV1ListenerEvent: Sendable { case opened(Int, String), frame(Int, Data), closed(Int) }

final class HostApiV1Listener: @unchecked Sendable {
    static var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    static func devListenerAllowed(environment: [String: String], isDebugBuild: Bool) -> Bool {
        isDebugBuild && environment["LLMIDE_HOST_API_DEV"] == "1"
    }

    enum Transport { case devPlaintext; case tls(SecIdentity) }
    enum Mode: Equatable { case off, devPlaintext, tls }

    static func mode(environment: [String: String], defaults: UserDefaults, isDebugBuild: Bool) -> Mode {
        if environment["LLMIDE_HOST_API_TLS"] == "1" || defaults.bool(forKey: "HostApiV1.tlsEnabled") { return .tls }
        return devListenerAllowed(environment: environment, isDebugBuild: isDebugBuild) ? .devPlaintext : .off
    }

    static func refusesHandshake(headers: [(name: String, value: String)], allowlist: [String]) -> Bool {
        HostApiV1Origins.refused(headers: headers, allowlist: allowlist)
    }

    static func tlsOptions(identity: SecIdentity) -> NWProtocolTLS.Options {
        let tls = NWProtocolTLS.Options()
        let sec = tls.securityProtocolOptions
        sec_protocol_options_set_local_identity(sec, sec_identity_create(identity)!)
        sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
        return tls
    }

    static func parameters(for transport: Transport, port: NWEndpoint.Port, ws: NWProtocolWebSocket.Options) -> NWParameters {
        let params: NWParameters
        switch transport {
        case .devPlaintext:
            params = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
            params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        case .tls(let identity):
            // Every interface: TLS is what makes a non-loopback peer acceptable (spec "Security").
            params = NWParameters(tls: tlsOptions(identity: identity), tcp: NWProtocolTCP.Options())
        }
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        return params
    }

    private let basePort: Int
    private let transport: Transport
    private let originAllowlist: [String]
    private let onRefused: (_ event: String, _ peer: String, _ detail: String) -> Void
    private let candidates: Int
    private let onOpen: (Int, String) -> Void
    private let onFrame: (Int, Data) -> Void
    private let onClose: (Int) -> Void
    private let onListening: (Int) -> Void
    private let onLog: (String) -> Void
    private let queue = DispatchQueue(label: "llmide.hostapi.v1")
    private var listener: NWListener?
    private var portIndex = 0
    private var stopped = false
    private var nextSession = 1
    private var connections: [Int: NWConnection] = [:]

    init(basePort: Int = 3016, candidates: Int = 10, transport: Transport, originAllowlist: [String],
         onRefused: @escaping (_ event: String, _ peer: String, _ detail: String) -> Void,
         onOpen: @escaping (Int, String) -> Void, onFrame: @escaping (Int, Data) -> Void,
         onClose: @escaping (Int) -> Void, onListening: @escaping (Int) -> Void, onLog: @escaping (String) -> Void) {
        self.basePort = basePort
        self.transport = transport; self.originAllowlist = originAllowlist; self.onRefused = onRefused
        self.candidates = max(1, min(candidates, 65_535 - basePort + 1))
        self.onOpen = onOpen; self.onFrame = onFrame; self.onClose = onClose
        self.onListening = onListening; self.onLog = onLog
    }

    func start() throws { try queue.sync { stopped = false; portIndex = 0; try bind() } }

    func stop() {
        queue.async {
            self.stopped = true
            self.listener?.cancel(); self.listener = nil
            for (_, c) in self.connections { c.stateUpdateHandler = nil; c.cancel() }
            self.connections.removeAll()
        }
    }

    func send(_ session: Int, _ data: Data) {
        queue.async {
            guard let conn = self.connections[session] else { return }
            let meta = NWProtocolWebSocket.Metadata(opcode: .text)
            let ctx = NWConnection.ContentContext(identifier: "hostapi", metadata: [meta])
            conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
        }
    }

    func close(_ session: Int) {
        queue.asyncAfter(deadline: .now() + 0.2) {
            guard let conn = self.connections.removeValue(forKey: session) else { return }
            conn.stateUpdateHandler = nil
            conn.cancel()
        }
    }

    private func bind() throws {
        if stopped { return }
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = HostApi.limits.maxFrameBytes
        let allowlist = originAllowlist, onRefused = onRefused
        ws.setClientRequestHandler(queue) { _, headers in
            let pairs = headers.map { (name: $0.name, value: $0.value) }
            guard Self.refusesHandshake(headers: pairs, allowlist: allowlist) else { return .init(status: .accept, subprotocol: nil) }
            // Network.framework does not hand this handler the peer, hence "-".
            let origin = pairs.first { $0.name.lowercased() == "origin" }?.value ?? ""
            onRefused("origin_refused", "-", HostApiFrame.clamp(origin, maxUTF16: 200))
            return .init(status: .reject, subprotocol: nil)
        }
        guard let raw = UInt16(exactly: basePort + portIndex), let port = NWEndpoint.Port(rawValue: raw) else {
            throw NWError.posix(.EADDRNOTAVAIL)
        }
        let params = Self.parameters(for: transport, port: port, ws: ws)
        let l: NWListener
        if case .tls = transport { l = try NWListener(using: params, on: port) } else { l = try NWListener(using: params) }
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.stateUpdateHandler = { [weak self, weak l] state in
            guard let self else { return }
            switch state {
            case .ready:
                let p = self.basePort + self.portIndex
                if case .tls = self.transport { self.onLog("Host API v1 (TLS, all interfaces) listening on :\(p)") }
                else { self.onLog("Host API v1 (development, loopback only) listening on 127.0.0.1:\(p)") }
                self.onListening(self.basePort + self.portIndex)
            case .failed(let error):
                l?.cancel()
                if case .posix(.EADDRINUSE) = error, self.portIndex + 1 < self.candidates {
                    self.portIndex += 1
                    do { try self.bind() } catch { self.onLog("❌ Host API v1 listener rebind failed — \(error.localizedDescription)") }
                } else {
                    self.onLog("❌ Host API v1 listener failed — \(error.localizedDescription)")
                }
            default: break
            }
        }
        listener = l
        l.start(queue: queue)
    }

    private func accept(_ conn: NWConnection) {
        if stopped { conn.cancel(); return }
        guard case let .hostPort(host, _) = conn.endpoint else { conn.cancel(); return }
        // Plaintext only: defence in depth beside requiredLocalEndpoint, only a loopback peer is served.
        if case .devPlaintext = transport, !Self.isLoopback(host) {
            onRefused("plaintext_refused", "\(host)", "")
            conn.cancel(); return
        }
        let session = nextSession
        nextSession += 1
        connections[session] = conn
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onOpen(session, "\(host)")
                self.receive(session, conn)
            case .failed, .cancelled:
                if self.connections.removeValue(forKey: session) != nil { self.onClose(session) }
                conn.stateUpdateHandler = nil
            default: break
            }
        }
        conn.start(queue: queue)
    }

    private func receive(_ session: Int, _ conn: NWConnection) {
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            guard let data, error == nil else { conn.cancel(); return }
            self.onFrame(session, data)
            self.receive(session, conn)
        }
    }

    private static func isLoopback(_ host: NWEndpoint.Host) -> Bool {
        switch host {
        case .ipv4(let a): return a == .loopback
        case .ipv6(let a): return a == .loopback
        case .name(let n, _): return n == "localhost"
        @unknown default: return false
        }
    }
}
