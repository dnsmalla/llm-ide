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
    private let onClientPaired: () -> Void
    private let onClientDisconnected: () -> Void
    private let onBindFailed: (Error) -> Void
    private let queue = DispatchQueue(label: "llmide.mobile.ws")
    /// Shared decoder for inbound `Pairing`/`Heartbeat` frames. `JSONDecoder`
    /// is thread-safe for independent `decode(_:)` calls; all access here runs
    /// on the serial `queue`, so one instance covers both inbound paths.
    private let decoder = JSONDecoder()
    private var listener: NWListener?
    private var client: NWConnection?
    private var paired = false
    /// Run intent: true between start() and stop(). Gates the EADDRINUSE
    /// retry so a stop() during a pending retry doesn't rebind after the user
    /// asked to stop. All access on the serial `queue`.
    private var shouldRun = false
    /// Bounded EADDRINUSE retry budget (initial attempt + retries). The port
    /// releases slightly AFTER the previous listener's `.cancelled` state, so a
    /// rapid stop→start races the new bind; a few short retries cover that lag.
    private static let maxStartAttempts = 4
    private var startAttempts = 0

    typealias InboundHandler = (Data) -> Void

    init(port: Int, deviceName: String,
         validatePin: @escaping (String) -> Bool,
         onInbound: @escaping InboundHandler,
         onLog: @escaping (String) -> Void,
         onClientPaired: @escaping () -> Void = {},
         onClientDisconnected: @escaping () -> Void = {},
         onBindFailed: @escaping (Error) -> Void = { _ in }) {
        self.port = port
        self.deviceName = deviceName
        self.validatePin = validatePin
        self.onInbound = onInbound
        self.onLog = onLog
        self.onClientPaired = onClientPaired
        self.onClientDisconnected = onClientDisconnected
        self.onBindFailed = onBindFailed
    }

    func start() throws {
        // Set run intent + reset the retry budget, then create the listener.
        // NWListener's bind resolves asynchronously, and a stop() immediately
        // before this releases :port only after the listener's `.cancelled`
        // state fires — slightly AFTER a rapid restart's new bind. That race
        // surfaces as EADDRINUSE, so startListener() retries the bind a few
        // times before giving up.
        shouldRun = true
        startAttempts = 0
        try startListener()
    }

    /// Create + start the NWListener. On an EADDRINUSE bind failure (the port
    /// is still releasing after a recent stop, OR a genuine squatter), retry a
    /// few times with a short backoff before surfacing the error — the previous
    /// listener is mid-release, not squatting permanently. Idempotent: cancels
    /// any lingering listener first, so retries and re-starts never stack two.
    private func startListener() throws {
        listener?.cancel()
        listener = nil
        let opts = NWProtocolWebSocket.Options()
        opts.autoReplyPing = true
        opts.maximumMessageSize = 8_388_608   // 8 MiB — matches the :3456 body cap; paired-LAN only
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(opts, at: 0)
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: UInt16(port))!)
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                // Bind succeeded. Logging "listening" only here (not right
                // after start()) because the socket bind resolves
                // asynchronously — logging earlier would falsely report up.
                self.startAttempts = 0   // a clean bind refills the retry budget
                self.onLog("WebSocket listening on :\(self.port)")
            case .failed(let error):
                // Bind failures arrive HERE asynchronously, not as a throw from
                // start(). The common one right after a stop() is EADDRINUSE —
                // the previous listener is still releasing the port. Retry the
                // bind a few times; only a PERSISTENT failure (e.g. another
                // process squatting) is surfaced via onBindFailed so the manager
                // can show the actionable `lsof -i :3006` hint.
                self.listener = nil
                if self.shouldRun, Self.isAddrInUse(error), self.startAttempts < Self.maxStartAttempts {
                    self.startAttempts += 1
                    self.onLog("⏳ :\(self.port) still releasing after stop — retrying bind (\(self.startAttempts)/\(Self.maxStartAttempts))…")
                    self.queue.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                        guard let self, self.shouldRun else { return }
                        do { try self.startListener() }
                        catch { self.onBindFailed(error) }
                    }
                } else {
                    self.onLog("❌ Listener failed on :\(self.port) — \(error.localizedDescription)")
                    self.onBindFailed(error)
                }
            case .cancelled:
                // Intentional stop() — not a failure.
                break
            default:
                break
            }
        }
        self.listener = listener          // assign BEFORE start
        listener.start(queue: queue)
    }

    /// True iff `error` is EADDRINUSE — the port is already bound. The
    /// transient form right after stop() (previous listener mid-release) is
    /// what the retry above absorbs. NWError's POSIX case carries a
    /// `POSIXErrorCode` enum, so compare against `.EADDRINUSE` directly.
    private static func isAddrInUse(_ error: NWError) -> Bool {
        if case .posix(.EADDRINUSE) = error { return true }
        return false
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.shouldRun = false   // halt any pending EADDRINUSE retry
            self.client?.cancel()
            self.client = nil
            self.listener?.cancel()
            self.listener = nil
            self.paired = false
        }
    }

    /// JSON-encode and send to the active client (no-op if none/paired==false).
    /// Encoding runs off the cooperative thread pool; state reads + the actual
    /// send are dispatched onto `queue` so `client`/`paired` stay race-free.
    func send(_ message: some Encodable) async {
        guard let data = try? JSONEncoder().encode(message),
              let string = String(data: data, encoding: .utf8) else {
            let type = String(describing: type(of: message))
            onLog("Mobile WS send: encode failed for \(type)")
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async { [weak self] in
                guard let self, let client = self.client, self.paired else {
                    cont.resume(); return
                }
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "msg", metadata: [metadata])
                client.send(content: string.data(using: .utf8), contentContext: context,
                            isComplete: true, completion: .contentProcessed { _ in })
                let preview = String(string.prefix(80))
                self.onLog("📤 Sent \(string.count) bytes: \(preview)")
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
                self?.onClientDisconnected()
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
            guard let self, let data, error == nil else {
                if let error {
                    self?.onLog("❌ Receive error: \(error.localizedDescription)")
                }
                return
            }
            let preview = String(data: data, encoding: .utf8)?.prefix(60) ?? "<binary>"
            self.onLog("📥 Received \(data.count) bytes: \(preview)")
            if !self.paired {
                self.handlePairing(data: data)
            } else {
                self.routeInbound(data: data)
            }
            self.receive()   // continue the receive loop
        }
    }

    private func handlePairing(data: Data) {
        guard let pairing = try? decoder.decode(Pairing.self, from: data) else {
            onLog("First frame was not a Pairing message — closing")
            closeWithAuthFailure()
            return
        }
        if validatePin(pairing.pin) {
            paired = true
            onLog("Client paired")
            onClientPaired()
            Task { await self.send(Connected(deviceName: deviceName)) }
        } else {
            // Diagnostic: show the received candidate's shape (not its value)
            // so a lingering mismatch — typo, non-digit, wrong length — is
            // visible in the Mobile Control log pane without leaking the PIN.
            let received = pairing.pin
            let digits = !received.isEmpty && received.allSatisfy { ("0"..."9").contains($0) }
            onLog("Wrong PIN — rejecting (received \(received.count) char\(received.count == 1 ? "" : "s")\(digits ? ", all digits" : ", has non-digits"))")
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

    /// True only for a genuine `Heartbeat` frame.
    ///
    /// Decodes the `{type}` envelope and compares it to the heartbeat tag — NOT
    /// `decode(Heartbeat.self)`. Like every SharedProtocol `let type = "…"`
    /// struct with a synthesized `init(from:)`, `Heartbeat` reads `type` on
    /// decode without VALIDATING it, so `decode(Heartbeat.self)` succeeds for
    /// ANY JSON that has a `type` field and would swallow every chat / explorer
    /// / auto-task frame as a heartbeat (the live bug: Mac showed nothing, no
    /// reply, every surface, iPhone spun to timeout). `handleInbound` avoids
    /// the same gotcha by dispatching on an envelope `{type}` + `switch`.
    static func isHeartbeatFrame(_ data: Data) -> Bool {
        struct Envelope: Decodable { let type: String }
        guard let env = try? JSONDecoder().decode(Envelope.self, from: data) else { return false }
        return env.type == MobileProtocol.Tag.heartbeat
    }

    private func routeInbound(data: Data) {
        // Heartbeat is handled here; everything else is forwarded to the manager.
        // Use the envelope `type` via `isHeartbeatFrame` — never
        // `decode(Heartbeat.self)`, which greedily matches every typed frame.
        if Self.isHeartbeatFrame(data) {
            Task { await self.send(HeartbeatAck(ts: Date().timeIntervalSince1970)) }
            return
        }
        let preview = String(data: data, encoding: .utf8)?.prefix(80) ?? "<binary>"
        onLog("📨 routeInbound: forwarding message (\(data.count) bytes): \(preview)")
        onInbound(data)
    }
}
