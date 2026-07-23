import Foundation
import Network
import SharedProtocol

/// Native WebSocket server (Network.framework). Accepts one active client at a
/// time (replace policy). Auth is message-based: the client's first text frame
/// must be a `Pairing{pin}`; on match the server sends `Connected` and begins
/// app-level heartbeat; on mismatch it sends `AuthFailed` and closes.
///
/// `@unchecked Sendable` is safe and intentional: every mutable field
/// (`listener`, `client`, `paired`) is read/written exclusively on the serial
/// `queue` — Network.framework callbacks run there, and `send`/`stop`/
/// `closeWithAuthFailure` hop there via `queue.async` before touching state.
final class MobileWebSocketServer: @unchecked Sendable {
    private let port: Int
    private let deviceName: String
    private let validatePin: (String) -> Bool
    private let onInbound: InboundHandler
    private let onLog: (String) -> Void
    private let queue = DispatchQueue(label: "llmide.mobile.ws")
    private var listener: NWListener?
    private var client: NWConnection?
    private var paired = false

    typealias InboundHandler = (Data) -> Void

    init(port: Int, deviceName: String,
         validatePin: @escaping (String) -> Bool,
         onInbound: @escaping InboundHandler,
         onLog: @escaping (String) -> Void) {
        self.port = port
        self.deviceName = deviceName
        self.validatePin = validatePin
        self.onInbound = onInbound
        self.onLog = onLog
    }

    func start() throws {
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        opts.maximumMessageSize = 1_048_576
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: UInt16(port))!)
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener.start(queue: queue)
        self.listener = listener
        onLog("WebSocket listening on :\(port)")
    }

    func stop() {
        queue.async { [weak self] in
            self?.client?.cancel()
            self?.client = nil
            self?.listener?.cancel()
            self?.listener = nil
            self?.paired = false
        }
    }

    /// JSON-encode and send to the active client (no-op if none/paired==false).
    /// Encoding runs off the cooperative thread pool; state reads + the actual
    /// send are dispatched onto `queue` so `client`/`paired` stay race-free.
    func send(_ message: some Encodable) async {
        guard let data = try? JSONEncoder().encode(message),
              let string = String(data: data, encoding: .utf8) else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async { [weak self] in
                guard let self, let client = self.client, self.paired else {
                    cont.resume(); return
                }
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "msg", metadata: [metadata])
                client.send(content: string.data(using: .utf8), contentContext: context,
                            isComplete: true, completion: .contentProcessed { _ in })
                cont.resume()
            }
        }
    }

    private func handle(_ conn: NWConnection) {
        // Single-client "replace": drop any existing client first.
        client?.cancel()
        client = conn
        paired = false
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.onLog("Client connected — awaiting pairing")
                self?.receive()
            case .failed, .cancelled:
                self?.onLog("Client disconnected")
                self?.client = nil
                self?.paired = false
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private func receive() {
        guard let client else { return }
        client.receiveMessage { [weak self] data, _, _, error in
            guard let self, let data, error == nil else { return }
            if !self.paired {
                self.handlePairing(data: data)
            } else {
                self.routeInbound(data: data)
            }
            self.receive()   // continue the receive loop
        }
    }

    private func handlePairing(data: Data) {
        guard let pairing = try? JSONDecoder().decode(Pairing.self, from: data) else {
            onLog("First frame was not a Pairing message — closing")
            closeWithAuthFailure()
            return
        }
        if validatePin(pairing.pin) {
            paired = true
            onLog("Client paired")
            Task { await self.send(Connected(deviceName: deviceName)) }
        } else {
            onLog("Wrong PIN — rejecting")
            closeWithAuthFailure()
        }
    }

    private func closeWithAuthFailure() {
        Task { [weak self] in
            guard let self else { return }
            await self.send(AuthFailed(message: "Wrong PIN"))
            self.queue.async {
                self.client?.cancel()
                self.client = nil
                self.paired = false
            }
        }
    }

    private func routeInbound(data: Data) {
        // Heartbeat is handled here; everything else is forwarded to the manager
        // (Phase 3 wires chat/commands; Phase 4/5 wire viewing/input).
        if let hb = try? JSONDecoder().decode(Heartbeat.self, from: data),
           hb.type == "heartbeat" {
            Task { await self.send(HeartbeatAck(ts: Date().timeIntervalSince1970)) }
            return
        }
        onInbound(data)
    }
}
