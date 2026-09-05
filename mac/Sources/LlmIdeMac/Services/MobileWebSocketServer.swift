import Foundation
import Network
import SharedProtocol

/// Native WebSocket server (Network.framework). One PAIRED client at a time,
/// with a pair-before-evict handshake: a new connection is a *challenger* whose
/// first text frame must be a `Pairing{pin}`. On match the server sends
/// `Connected`, replaces any incumbent, and begins app-level heartbeat; on
/// mismatch the challenger alone gets `AuthFailed` and is dropped — the paired
/// phone is never disturbed by an unauthenticated peer. Attempts are
/// rate-limited per remote host (`PairingThrottle`), without which a 6-digit
/// PIN is brute-forceable in hours over a LAN.
///
/// `@unchecked Sendable` is safe and intentional: every mutable field
/// (`listener`, `client`, `paired`, `challengers`, `throttle`) is read/written exclusively on the serial
/// `queue` — Network.framework callbacks run there, and `send`/`stop`/
/// `reject` hop there via `queue.async` before touching state.
final class MobileWebSocketServer: @unchecked Sendable {
    /// The port the caller asked for. What the listener actually binds is
    /// `currentPort` — the base plus the fallback offset.
    private let basePort: Int
    /// How many consecutive ports (base, base+1, …) may be tried before the
    /// bind is surfaced as failed. 1 = the old exact-port behaviour.
    private let portCandidates: Int
    /// Offset of the candidate currently being bound / bound. Serial-queue
    /// only, like every other mutable field here.
    private var portIndex = 0
    private var currentPort: Int { basePort + portIndex }
    private let deviceName: String
    private let validatePin: (String) -> Bool
    /// (deviceId, token) → is this the live token for that device? Token auth
    /// is how a phone that paired before reconnects without a PIN.
    private let authenticateToken: (String, String) -> Bool
    /// (deviceId, deviceName) → a fresh token to hand the phone after a PIN
    /// pairing, or nil when tokens aren't offered. Issuing one is what lets
    /// the PIN rotate (`onPinConsumed`).
    private let issueToken: (String, String) -> String?
    private let onInbound: InboundHandler
    private let onLog: (String) -> Void
    private let onClientPaired: () -> Void
    /// The device id of the client that just paired — nil for an older phone
    /// that paired with a bare PIN. Fired just before `onClientPaired`.
    private let onClientIdentified: (String?) -> Void
    /// A PIN pairing just issued a token: the PIN has served its purpose and
    /// the owner should rotate it so a shoulder-surfed or captured PIN can't
    /// be replayed.
    private let onPinConsumed: () -> Void
    private let onClientDisconnected: () -> Void
    private let onBindFailed: (Error) -> Void
    /// Fired once per successful bind with the port that actually took —
    /// which may be a fallback candidate, so the caller must advertise THIS
    /// value (Bonjour, pairing QR, the settings Port row), never the base.
    private let onListening: (Int) -> Void
    private let queue = DispatchQueue(label: "llmide.mobile.ws")
    /// Shared decoder for inbound `Pairing`/`Heartbeat` frames. `JSONDecoder`
    /// is thread-safe for independent `decode(_:)` calls; all access here runs
    /// on the serial `queue`, so one instance covers both inbound paths.
    private let decoder = JSONDecoder()
    private var listener: NWListener?
    /// The PAIRED client. A connection only becomes `client` after presenting a
    /// valid PIN (see `handlePairing`); until then it lives in `challengers`.
    private var client: NWConnection?
    private var paired = false
    /// Device id the paired client authenticated as (token auth, or a PIN
    /// pairing that requested a token). nil for a legacy PIN-only phone.
    private var clientDeviceId: String?
    /// Connections that have arrived but not yet paired. They never reach
    /// `onInbound`, and they never displace the incumbent `client` — that only
    /// happens on a proven PIN. Bounded so a peer opening sockets in a loop
    /// can't exhaust descriptors.
    private var challengers: [NWConnection] = []
    private static let maxChallengers = 2
    /// How long an unpaired peer may hold a slot before it is dropped.
    private static let handshakeDeadline: TimeInterval = 10
    /// Per-host brute-force defence for the 6-digit PIN. Serial-queue only.
    private var throttle = PairingThrottle()
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

    /// How many consecutive ports a default-configured server may try. Ten
    /// keeps the range small enough to state in an error message while making
    /// a single squatter (the classic retired-computer-agent-on-:3006 case) a
    /// log line instead of a dead server.
    static let defaultPortCandidates = 10

    init(port: Int, portCandidates: Int = MobileWebSocketServer.defaultPortCandidates,
         deviceName: String,
         validatePin: @escaping (String) -> Bool,
         authenticateToken: @escaping (String, String) -> Bool = { _, _ in false },
         issueToken: @escaping (String, String) -> String? = { _, _ in nil },
         onInbound: @escaping InboundHandler,
         onLog: @escaping (String) -> Void,
         onClientPaired: @escaping () -> Void = {},
         onClientIdentified: @escaping (String?) -> Void = { _ in },
         onPinConsumed: @escaping () -> Void = {},
         onClientDisconnected: @escaping () -> Void = {},
         onListening: @escaping (Int) -> Void = { _ in },
         onBindFailed: @escaping (Error) -> Void = { _ in }) {
        self.basePort = port
        self.portCandidates = max(1, portCandidates)
        self.onListening = onListening
        self.deviceName = deviceName
        self.validatePin = validatePin
        self.authenticateToken = authenticateToken
        self.issueToken = issueToken
        self.onInbound = onInbound
        self.onLog = onLog
        self.onClientPaired = onClientPaired
        self.onClientIdentified = onClientIdentified
        self.onPinConsumed = onPinConsumed
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
        portIndex = 0
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
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: UInt16(currentPort))!)
        listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                // Bind succeeded. Logging "listening" only here (not right
                // after start()) because the socket bind resolves
                // asynchronously — logging earlier would falsely report up.
                self.startAttempts = 0   // a clean bind refills the retry budget
                self.onLog("WebSocket listening on :\(self.currentPort)")
                self.onListening(self.currentPort)
            case .failed(let error):
                // Bind failures arrive HERE asynchronously, not as a throw from
                // start(). The common one right after a stop() is EADDRINUSE —
                // the previous listener is still releasing the port. Retry the
                // bind a few times; only a PERSISTENT failure (e.g. another
                // process squatting) is surfaced via onBindFailed so the manager
                // can show the actionable `lsof -i :3006` hint.
                self.listener = nil
                if self.shouldRun, Self.isAddrInUse(error),
                   self.portIndex == 0, self.startAttempts < Self.maxStartAttempts {
                    // The BASE port only: right after a stop() it is usually
                    // this server's own socket mid-release, so a short wait
                    // wins it back. A fallback candidate was never ours — a
                    // squatter there won't release, so it gets one try.
                    self.startAttempts += 1
                    self.onLog("⏳ :\(self.currentPort) still releasing after stop — retrying bind (\(self.startAttempts)/\(Self.maxStartAttempts))…")
                    self.queue.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                        guard let self, self.shouldRun else { return }
                        do { try self.startListener() }
                        catch { self.onBindFailed(error) }
                    }
                } else if self.shouldRun, Self.isAddrInUse(error),
                          self.portIndex + 1 < self.portCandidates {
                    // Another process owns this port. Slide to the next
                    // candidate — Bonjour and the pairing QR advertise the
                    // port that actually binds (onListening), so the phone
                    // follows automatically.
                    self.portIndex += 1
                    self.onLog("⚠️ :\(self.currentPort - 1) is taken by another process — trying :\(self.currentPort)…")
                    self.queue.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                        guard let self, self.shouldRun else { return }
                        do { try self.startListener() }
                        catch { self.onBindFailed(error) }
                    }
                } else {
                    self.onLog("❌ Listener failed on :\(self.currentPort) — \(error.localizedDescription)")
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

    /// Tear down the listener and any client.
    ///
    /// Captures `self` STRONGLY on purpose. Callers drop their reference right
    /// after calling this (`server?.stop(); server = nil`), so a `[weak self]`
    /// capture let the object deallocate before the queue ever ran the block —
    /// `guard let self else { return }` bailed and `listener.cancel()` never
    /// happened. An `NWListener` released without `cancel()` keeps its socket
    /// bound for the lifetime of the PROCESS, so Kill & Restart then hit
    /// EADDRINUSE against the app's own leaked listener, and no amount of
    /// retrying could win: the port was never coming back. The strong capture
    /// is one-shot and released as soon as the block completes.
    func stop() {
        queue.async {
            self.shouldRun = false   // halt any pending EADDRINUSE retry
            if let client = self.client {
                client.stateUpdateHandler = nil
                // Tell the phone this is a deliberate stop, not a dropped
                // network — and let the frame flush before the socket goes.
                // Only the client cancel is deferred; the listener below is
                // released immediately so the port comes back promptly.
                if self.paired {
                    self.sendDirect(Disconnected(code: .stopped, message: "Mobile Control was stopped on the Mac"), to: client)
                    self.queue.asyncAfter(deadline: .now() + 0.2) { client.cancel() }
                } else {
                    client.cancel()
                }
            }
            self.client = nil
            self.clientDeviceId = nil
            // Unpaired peers mid-handshake must go too, or they linger holding
            // a socket (and a receive loop) past the user's Stop.
            for challenger in self.challengers {
                challenger.stateUpdateHandler = nil
                challenger.cancel()
            }
            self.challengers.removeAll()
            self.listener?.cancel()
            self.listener = nil
            self.paired = false
        }
    }

    /// Backstop for any path that releases the server without calling `stop()`
    /// — same reasoning as above: an uncancelled `NWListener` holds the port
    /// until the process exits. Cancelling here is safe without hopping to
    /// `queue`: deinit means nothing else can reach these properties.
    deinit {
        listener?.cancel()
        client?.stateUpdateHandler = nil
        client?.cancel()
        for challenger in challengers {
            challenger.stateUpdateHandler = nil
            challenger.cancel()
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

    /// Frame-send to ONE specific connection, bypassing `send`'s paired-client
    /// guard. `AuthFailed` by definition goes to a connection that is NOT
    /// paired, and `send`'s `self.paired` check silently dropped it — so until
    /// now a wrong PIN closed the socket with no reason on the wire at all,
    /// which is half of why the phone showed no error. Must run on `queue`.
    private func sendDirect(_ message: some Encodable, to conn: NWConnection) {
        guard let data = try? JSONEncoder().encode(message) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "msg", metadata: [metadata])
        conn.send(content: data, contentContext: context, isComplete: true,
                  completion: .contentProcessed { _ in })
    }

    /// Remote HOST of a connection — the throttle key. The port is excluded
    /// deliberately: it changes on every reconnect, so keying on the full
    /// endpoint would reset an attacker's failure counter for free.
    private static func hostKey(for conn: NWConnection) -> String {
        guard case let .hostPort(host, _) = conn.endpoint else {
            return String(describing: conn.endpoint)
        }
        switch host {
        case .ipv4(let addr): return "\(addr)"
        case .ipv6(let addr):
            // Key on the /64, not the full address: an on-link attacker owns a
            // whole /64 and would otherwise get a fresh failure counter for
            // every guess simply by picking a new source address.
            return PairingThrottle.ipv6PrefixKey("\(addr)")
        case .name(let name, _): return name
        @unknown default: return String(describing: host)
        }
    }

    /// True only for a genuine `Pairing` frame. Same reasoning as
    /// `isHeartbeatFrame`: `decode(Pairing.self)` does not validate `type`, so
    /// ANY JSON carrying a `pin` field would be accepted as a pairing attempt.
    static func isPairingFrame(_ data: Data) -> Bool {
        struct Envelope: Decodable { let type: String }
        guard let env = try? JSONDecoder().decode(Envelope.self, from: data) else { return false }
        return env.type == MobileProtocol.Tag.pairing
    }

    private func handle(_ conn: NWConnection) {
        // PAIR BEFORE EVICT. The old policy cancelled the incumbent client the
        // moment ANY peer connected, so any host on the network — including a
        // malicious web page, since a browser WebSocket is not subject to
        // same-origin policy and we never inspect Origin — could kick the
        // paired iPhone off in a loop while grinding PIN guesses. A new
        // connection is now only a CHALLENGER: it gets its own receive loop,
        // must pair first, and only then replaces the incumbent.
        // Evict the OLDEST waiting challenger rather than refusing the newest:
        // refusing the newest let two idle sockets lock the real phone out
        // (the old replace policy always admitted a new phone).
        while challengers.count >= Self.maxChallengers, let stale = challengers.first {
            onLog("Dropping the oldest unpaired peer to admit a new connection")
            dropChallenger(stale)
        }
        challengers.append(conn)
        // Unpaired peers get a deadline. Without one, a socket that completes
        // TCP but never sends a pairing frame stays in `.preparing` forever —
        // no `.failed`, no `.cancelled`, no removal.
        queue.asyncAfter(deadline: .now() + Self.handshakeDeadline) { [weak self] in
            guard let self, self.challengers.contains(where: { $0 === conn }) else { return }
            self.onLog("Unpaired peer timed out — dropping")
            self.dropChallenger(conn)
        }
        conn.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard conn !== self.client else { return }  // incumbent re-reporting
                self.onLog("Client connected — awaiting pairing")
                self.receive(on: conn)
            case .failed, .cancelled:
                self.challengers.removeAll { $0 === conn }
                if conn === self.client {
                    self.onLog("Client disconnected")
                    self.client = nil
                    self.paired = false
                    self.clientDeviceId = nil
                    self.onClientDisconnected()
                }
                // Break the conn → handler → conn retain cycle.
                conn.stateUpdateHandler = nil
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    /// Remove one unpaired peer and tear its socket down. Clears the state
    /// handler first so the `conn → handler → conn` cycle is broken even when
    /// the cancellation callback doesn't run.
    private func dropChallenger(_ conn: NWConnection) {
        challengers.removeAll { $0 === conn }
        conn.stateUpdateHandler = nil
        conn.cancel()
    }

    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            guard let data, error == nil else {
                if let error {
                    self.onLog("❌ Receive error: \(error.localizedDescription)")
                }
                return
            }
            let preview = String(data: data, encoding: .utf8)?.prefix(60) ?? "<binary>"
            self.onLog("📥 Received \(data.count) bytes: \(preview)")
            // Only the PAIRED connection's frames reach the app; everyone else
            // is still in the pairing handshake.
            if conn === self.client, self.paired {
                self.routeInbound(data: data)
            } else {
                self.handlePairing(data: data, from: conn)
            }
            self.receive(on: conn)   // continue the receive loop
        }
    }

    private func handlePairing(data: Data, from conn: NWConnection) {
        let host = Self.hostKey(for: conn)
        // Rate-limit BEFORE inspecting the PIN: a 6-digit secret is only a
        // secret while guesses are expensive (see PairingThrottle).
        switch throttle.decision(for: host, now: Date()) {
        case .allow:
            break
        case .wait(let seconds):
            onLog("Pairing from \(host) too soon — \(Int(seconds.rounded()))s penalty left")
            // retryable: the PIN was never even examined, so the phone must
            // NOT throw away a PIN that may well be correct.
            reject(conn, message: "Too many attempts — wait a moment and try again", retryable: true)
            return
        case .lockedOut:
            onLog("Pairing from \(host) refused — host locked out")
            reject(conn, message: "Too many wrong PINs — this device is locked out for 15 minutes",
                   retryable: true)
            return
        case .serverThrottled:
            // The refused peer may have a clean record — never tell it that it
            // entered too many wrong PINs.
            onLog("Pairing from \(host) refused — server-wide attempt budget spent")
            reject(conn, message: "Your Mac is refusing new pairings for a few minutes after too many failed attempts. Try again shortly.",
                   retryable: true)
            return
        }
        guard Self.isPairingFrame(data),
              let pairing = try? decoder.decode(Pairing.self, from: data) else {
            onLog("First frame was not a Pairing message — closing")
            throttle.registerFailure(host: host, now: Date())
            reject(conn, message: "Expected a pairing message", retryable: false)
            return
        }
        let deviceId = Self.cleanDeviceId(pairing.deviceId)
        // Token auth: a phone that paired before. The token stands in for the
        // PIN entirely — no PIN is examined, so a rotated PIN changes nothing
        // for an already-paired phone. A stale or revoked token is a plain
        // refusal (not retryable): the phone must pair again with the current
        // PIN. It still costs a throttle failure so tokens can't be ground
        // any faster than PINs.
        if let token = pairing.token, !token.isEmpty {
            guard let deviceId, authenticateToken(deviceId, token) else {
                throttle.registerFailure(host: host, now: Date())
                onLog("Rejected token auth — unknown device or a stale/revoked token")
                reject(conn, message: "This device is no longer paired with this Mac — pair again with the current PIN",
                       retryable: false)
                return
            }
            throttle.registerSuccess(host: host)
            admit(conn, deviceId: deviceId, reply: Connected(deviceName: deviceName))
            return
        }
        if validatePin(pairing.pin) {
            throttle.registerSuccess(host: host)
            // A phone that identifies itself gets a token and never needs the
            // PIN again. Either way the PIN is one-time: it rotates after EVERY
            // successful use (`onPinConsumed`), so a PIN that was read over a
            // shoulder, captured, or presented by a client that deliberately
            // omits `deviceId` (and so never shows up in Settings) cannot be
            // reused. A legacy phone still pairs — with the PIN shown at that
            // moment — and has to re-pair next time.
            var reply = Connected(deviceName: deviceName)
            if let deviceId, let token = issueToken(deviceId, pairing.deviceName ?? "") {
                reply = Connected(deviceName: deviceName, token: token, deviceId: deviceId)
            }
            admit(conn, deviceId: reply.token != nil ? deviceId : nil, reply: reply)
            onPinConsumed()
        } else {
            throttle.registerFailure(host: host, now: Date())
            // Diagnostic: show the received candidate's shape (not its value)
            // so a lingering mismatch — typo, non-digit, wrong length — is
            // visible in the Mobile Control log pane without leaking the PIN.
            let received = pairing.pin
            let digits = !received.isEmpty && received.allSatisfy { ("0"..."9").contains($0) }
            onLog("Wrong PIN — rejecting (received \(received.count) char\(received.count == 1 ? "" : "s")\(digits ? ", all digits" : ", has non-digits"))")
            reject(conn, message: "Wrong PIN", retryable: false)
        }
    }

    /// Promote an authenticated challenger to THE client. Must run on `queue`.
    private func admit(_ conn: NWConnection, deviceId: String?, reply: Connected) {
        // NOW the incumbent may be replaced — after proven credentials, never
        // before. Its handler is cleared first so the cancellation below can't
        // race the `client` reassignment through the state handler. It is told
        // why (`replaced`) and the cancel is deferred so that frame flushes —
        // until now the ousted phone saw only a dead socket.
        if let incumbent = client, incumbent !== conn {
            onLog("Replacing previously paired client")
            incumbent.stateUpdateHandler = nil
            sendDirect(Disconnected(code: .replaced, message: "Another device paired with this Mac"), to: incumbent)
            queue.asyncAfter(deadline: .now() + 0.2) { incumbent.cancel() }
            // Deliberately NOT calling onClientDisconnected() here: the
            // manager wraps each callback in its own unstructured
            // MainActor Task, so a disconnect/paired pair can land
            // inverted and leave `mobileClientPaired == false` right
            // after a successful pair. The paired callback below does
            // the per-connection reset for the incoming client.
        }
        challengers.removeAll { $0 === conn }
        client = conn
        paired = true
        clientDeviceId = deviceId
        onLog(deviceId == nil ? "Client paired (PIN only)" : "Client paired (device \(deviceId!.prefix(8))…)")
        onClientIdentified(deviceId)
        onClientPaired()
        // Directly to THIS connection, synchronously on the queue — not via
        // `send`, which (a) targets whoever `client` is by the time its Task
        // runs, so a phone admitted in between would receive this phone's
        // token, and (b) logs an 80-char prefix of every frame, which for a
        // Connected{token} is a slice of the token.
        sendDirect(reply, to: conn)
        onLog(reply.token == nil ? "📤 Sent connected" : "📤 Sent connected (token issued)")
    }

    /// Drop the paired client if it is `deviceId`, telling it why first. This
    /// is the live half of revoking a device in Settings: the registry refuses
    /// the token from now on; this ends the session it may currently hold.
    func disconnectClient(deviceId: String, code: Disconnected.Code, message: String) {
        queue.async {
            guard let conn = self.client, self.paired, self.clientDeviceId == deviceId else { return }
            self.onLog("Disconnecting paired client (\(code.rawValue))")
            self.sendDirect(Disconnected(code: code, message: message), to: conn)
            // The state handler stays installed: its `.cancelled` branch clears
            // `client`/`paired` and fires onClientDisconnected as for any drop.
            self.queue.asyncAfter(deadline: .now() + 0.2) { conn.cancel() }
        }
    }

    /// A usable device id: trimmed, non-empty, bounded. Phones send a UUID;
    /// anything wildly longer is not a device id and is treated as absent.
    static func cleanDeviceId(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 128 else { return nil }
        return trimmed
    }

    /// Deliver a terminal `AuthFailed` to ONE connection and drop it. The
    /// incumbent paired client is untouched — that is the whole point of the
    /// challenger model. The teardown is deferred briefly so the frame
    /// actually flushes; cancelling inline discards it and the phone is left
    /// guessing why it was disconnected.
    private func reject(_ conn: NWConnection, message: String, retryable: Bool) {
        sendDirect(AuthFailed(message: message, retryable: retryable), to: conn)
        challengers.removeAll { $0 === conn }
        queue.asyncAfter(deadline: .now() + 0.2) {
            conn.stateUpdateHandler = nil
            conn.cancel()
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
