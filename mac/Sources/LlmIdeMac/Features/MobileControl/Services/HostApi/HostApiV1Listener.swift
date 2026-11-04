import Foundation
import Network
import SharedProtocol

/// Host API v1 development listener: plaintext WebSocket on 127.0.0.1 only, started only in a DEBUG build
/// with `LLMIDE_HOST_API_DEV=1` (spec "Security": plaintext only behind an explicit development flag;
/// production builds refuse it). TLS/WSS is spec phase 6. A handshake carrying `Origin` is refused:
/// there is no web client yet, and a page in the developer's browser must not reach the PIN.
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

    static func refusesHandshake(headers: [(name: String, value: String)]) -> Bool {
        headers.contains { $0.name.lowercased() == "origin" }
    }

    private let basePort: Int
    private let candidates: Int
    private let onOpen: (Int, String) -> Void
    private let onFrame: (Int, Data) -> Void
    private let onClose: (Int) -> Void
    private let onListening: (Int) -> Void
    private let onLog: (String) -> Void
    private let queue = DispatchQueue(label: "llmide.hostapi.v1")
    private var listener: NWListener?
    private var portIndex = 0
    private var nextSession = 1
    private var connections: [Int: NWConnection] = [:]

    init(basePort: Int = 3016, candidates: Int = 10,
         onOpen: @escaping (Int, String) -> Void, onFrame: @escaping (Int, Data) -> Void,
         onClose: @escaping (Int) -> Void, onListening: @escaping (Int) -> Void, onLog: @escaping (String) -> Void) {
        self.basePort = basePort
        self.candidates = max(1, min(candidates, 65_535 - basePort + 1))
        self.onOpen = onOpen; self.onFrame = onFrame; self.onClose = onClose
        self.onListening = onListening; self.onLog = onLog
    }

    func start() throws { try queue.sync { portIndex = 0; try bind() } }

    func stop() {
        queue.async {
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
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        ws.maximumMessageSize = HostApi.limits.maxFrameBytes
        ws.setClientRequestHandler(queue) { _, headers in
            let pairs = headers.map { (name: $0.name, value: $0.value) }
            return NWProtocolWebSocket.Response(status: Self.refusesHandshake(headers: pairs) ? .reject : .accept, subprotocol: nil)
        }
        let params = NWParameters(tls: nil, tcp: NWProtocolTCP.Options())
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        guard let raw = UInt16(exactly: basePort + portIndex), let port = NWEndpoint.Port(rawValue: raw) else {
            throw NWError.posix(.EADDRNOTAVAIL)
        }
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        let l = try NWListener(using: params)
        l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        l.stateUpdateHandler = { [weak self, weak l] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onLog("Host API v1 (development, loopback only) listening on 127.0.0.1:\(self.basePort + self.portIndex)")
                self.onListening(self.basePort + self.portIndex)
            case .failed(let error):
                l?.cancel()
                if case .posix(.EADDRINUSE) = error, self.portIndex + 1 < self.candidates {
                    self.portIndex += 1
                    try? self.bind()
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
        // Defence in depth beside requiredLocalEndpoint: only a loopback peer is served.
        guard case let .hostPort(host, _) = conn.endpoint, Self.isLoopback(host) else { conn.cancel(); return }
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
