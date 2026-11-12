import Foundation
import UIKit
import SharedProtocol

// MARK: — ConnectionService

/// Owns the Host API v1 connection to the paired desktop (TLS-pinned `wss://`): connect, backoff,
/// reconnect, and routing the client's `HostEvent`s to the chat store and the read screens.
@MainActor
final class ConnectionService: ObservableObject {
    @Published var connectionStatus: ConnectionStatus = .disconnected {
        didSet {
            // The host cancels a phone's turns when its connection drops, so a question or tool prompt
            // raised on the old connection can never be answered — a card left up would accept a tap
            // and look approved when nothing was.
            if connectionStatus != .connected, oldValue == .connected {
                liveSinks.forEach { $0.clearPendingPrompts() }
            }
        }
    }
    @Published var errorMessage: String?
    /// The saved device token expired (90-day limit) or the host revoked it. The pairing screen shows a direct
    /// re-pair path; cleared once a new pairing reaches `ready`.
    @Published private(set) var requiresRepair = false
    /// What the paired host serves (`host.hello` / `host.auth.*` / `host.capabilities`), or nil before the
    /// first connect of this pairing.
    @Published private(set) var hostCapabilities: Set<String>?
    /// The transport the chat + approvals slice speaks. While nothing is connected it is a client that was
    /// never connected, whose `send` throws `host_unreachable`.
    var host: HostConnection { v1Client ?? idleHost }
    private lazy var idleHost = HostApiV1Client(config: .init(clientName: "", clientVersion: ""),
                                                makeSocket: { preconditionFailure("the idle host never connects") })
    private var v1Client: HostApiV1Client?
    /// The client still in hello/auth, so a Disconnect, Forget or new connect can close it (final review I3).
    private var connectingV1: HostApiV1Client?

    /// Host API v1 `read` (chat list + one chat, read-only).
    @Published private(set) var readState = HostApiReadState()
    private(set) lazy var reads: HostApiReadController = {
        // The History tab follows the Chat tab's project (API 128): the same selectedId the picker persists.
        let r = HostApiReadController(host: { [weak self] in self?.v1Client },
                                      projectId: { [weak self] in self?.projectsStore?.selectedId })
        r.onChange = { [weak self] in self?.readState = $0 }
        return r
    }()
    /// True only on a connection whose host granted `read`. Not optimistic, unlike `supports`.
    var servesV1Read: Bool { HostApiReadGate.isOn(apiVersion: v1Client?.apiVersion ?? 0, capabilities: hostCapabilities) }

    /// Whether to offer a feature. Optimistic until the first handshake so the UI doesn't flicker
    /// after launch; after it, exactly what the host advertised.
    func supports(_ capability: String) -> Bool {
        hostCapabilities?.contains(capability) ?? true
    }

    enum ConnectionStatus {
        case disconnected, connecting, connected
    }

    /// Event consumers (the Ask and Execute chats register themselves). Weak: the app owns the stores.
    private struct WeakSink { weak var value: HostEventSink? }
    private var sinks: [WeakSink] = []
    private var liveSinks: [HostEventSink] { sinks.compactMap(\.value) }
    func registerSink(_ sink: HostEventSink) {
        sinks.removeAll { $0.value == nil }
        sinks.append(WeakSink(value: sink))
    }
    weak var usageStore: UsageStore?
    weak var projectsStore: ProjectsStore?
    /// Set at app launch: the pairing (address, pin, token) and the host name.
    weak var connectionStore: ConnectionStore?

    private var reconnectAttempt = 0
    /// Bumped whenever the active connection is replaced or torn down. A connect captures it and ignores
    /// its outcome when it changed, so a cancelled attempt cannot kill a newer one.
    private var connectionGeneration = 0
    private var reconnectTask: Task<Void, Never>?

    /// True after `closeConnection()` until the next `connect(...)` call.
    /// Distinguishes an intentional close (don't auto-reconnect) from an
    /// unexpected drop (auto-reconnect is correct) — `ContentView`'s
    /// launch/appear check reads this before reconnecting.
    private(set) var userClosed = false

    private var directIP: String?
    /// The host this app last pointed at. Unlike `directIP` it survives `disconnect(clearDirect: true)`
    /// (revoke / auth_failed), so re-pairing with a different computer still resets the stores.
    private var lastConnectedIP: String?
    private var directPIN: String?

    // MARK: — Connection

    func connect(ip: String, pin: String) {
        userClosed = false
        // Already live against this exact host: nothing to do.
        if connectionStatus == .connected, directIP == ip { return }
        // Re-pointing at a DIFFERENT host: the stores still hold the previous one's transcript and usage.
        if let previous = lastConnectedIP, previous != ip {
            resetStoresForNewDevice()
        }
        lastConnectedIP = ip
        directIP  = ip
        directPIN = pin
        // Clear the previous attempt's reason so an unchanged message still re-triggers the banner.
        errorMessage = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        invalidateSocket()
        if !pin.isEmpty { requiresRepair = false }
        // C5: a token past 90 days would be refused by the host anyway; surface the re-pair path without a dial.
        if connectionStore?.hostApiTokenExpired == true {
            connectionStore?.clearCredentials()
            requiresRepair = true
            errorMessage = HostApiNegotiation.rePairMessage
            connectionStatus = .disconnected
            return
        }
        // The endpoint exists only after a QR scan stored the host's pin (or a DEBUG dev URL).
        guard let endpoint = connectionStore?.hostApiEndpoint else {
            errorMessage = "Scan the pairing QR code in the desktop's Settings → Phone and browser → Live Chat pairing. This iPhone learns the desktop's security identity from the QR only."
            connectionStatus = .disconnected
            return
        }
        connectionStatus = .connecting
        let generation = connectionGeneration
        // wss without a stored pin is refused here, before any socket opens.
        let trust: HostApiTrustEvaluating?
        do { trust = try HostApiPinning.trust(for: endpoint, pin: connectionStore?.hostApiPin) } catch {
            return handleRefusal(HostApiPinning.missingPin)
        }
        let client = HostApiV1Client(
            config: .init(clientName: UIDevice.current.name,
                          clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"),
            makeSocket: { URLSessionHostApiSocket(url: endpoint.url, trust: trust) })
        client.onEvent = { [weak self] in self?.route($0) }
        let token = connectionStore?.hostApiToken ?? ""
        let credential: HostCredential = token.isEmpty ? .pin(pin) : .token(token)
        connectingV1 = client
        Task { @MainActor [weak self] in
            let outcome = await client.connect(credential)
            if self?.connectingV1 === client { self?.connectingV1 = nil }
            guard let self, generation == self.connectionGeneration else { client.close(); return }
            switch outcome {
            case .ready(let hello, let newToken):
                self.v1Client = client
                self.hostCapabilities = client.capabilities
                self.errorMessage = nil
                self.requiresRepair = false
                self.reconnectAttempt = 0
                self.connectionStore?.updateDeviceName(hello.hostName)
                if let newToken {
                    self.directPIN = nil
                    if self.connectionStore?.saveHostApiToken(newToken) == false {
                        self.errorMessage = "Connected, but the pairing token could not be saved to the Keychain — you will need to pair again next time."
                    }
                }
                self.connectionStatus = .connected
                PushRegistrar.shared.hostReady()
            case .unreachable:
                self.handleRefusal(HostApiRejection(
                    replyTo: nil, code: "host_unreachable",
                    message: "Couldn't reach the desktop. Check it's awake and on the same network (or Tailscale). Retrying…",
                    retryable: true))
            case .refused(let r):
                self.handleRefusal(r)
            }
        }
    }

    /// The host refused. Retryable (throttle, busy, unreachable) keeps the pairing and backs off. Only a
    /// non-retryable `auth_failed` (the device is not paired) clears the credentials and returns to pairing;
    /// any other refusal keeps the pairing and stops, showing the host's message.
    private func handleRefusal(_ r: HostApiRejection) {
        // A token-auth refusal is the 90-day/revoke case; a wrong PIN is also non-retryable `auth_failed`, but
        // there is no old session to repair, so it must not claim the pairing expired.
        let wasTokenAuth = !(connectionStore?.hostApiToken.isEmpty ?? true)
        let expiredSession = wasTokenAuth && HostApiNegotiation.isExpiredSession(r)
        errorMessage = !r.message.isEmpty ? r.message : expiredSession ? HostApiNegotiation.rePairMessage : "The desktop refused the connection."
        if r.retryable {
            reconnectAttempt = max(reconnectAttempt, 1)
            invalidateSocket()
            connectionStatus = .disconnected
            scheduleReconnect(retryAfterMs: r.retryAfterMs)
            return
        }
        guard HostApiNegotiation.clearsCredentials(r) else { return closeConnection() }
        directPIN = nil
        connectionStore?.clearCredentials()
        requiresRepair = expiredSession
        disconnect(clearDirect: true)
    }

    /// Transport events → app state and the chat store.
    private func route(_ event: HostEvent) {
        switch event {
        case .capabilities(let caps):
            hostCapabilities = caps
            if !servesV1Read { reads.reset() }   // `read` revoked: clear what is on screen now
            liveSinks.forEach { $0.handle(event) }
            PushRegistrar.shared.hostReady()
        case .disconnected(let reason):
            if !reason.retryable { return handleRefusal(reason) }
            if errorMessage == nil { errorMessage = "Disconnected from the desktop. Retrying…" }
            // v1 has no replay: no event for a turn on the old session can arrive, so end them all now.
            liveSinks.forEach { $0.handleChatError(commandId: nil) }
            invalidateSocket()
            connectionStatus = .disconnected
            scheduleReconnect(retryAfterMs: reason.retryAfterMs)
        case .resync:
            liveSinks.forEach { $0.handle(event) }
            projectsStore?.refresh()
            if servesV1Read { Task { await reads.refresh() } }
        case .event:
            liveSinks.forEach { $0.handle(event) }
        }
    }

    /// Wipe every mirrored surface so a newly paired host starts from a blank
    /// slate. Also the single place the "Forget" call sites use.
    func resetStoresForNewDevice() {
        liveSinks.forEach { $0.resetForNewDevice() }
        usageStore?.resetForNewDevice()
        projectsStore?.resetForNewDevice()
        reads.reset()
        // The next host may serve a different feature set; forget this one's until it says.
        hostCapabilities = nil
    }

    func disconnect() { disconnect(clearDirect: true) }

    /// Close the connection but keep the saved pairing (`directIP`/`directPIN`) so a later `connect`
    /// call — e.g. from a Reconnect action within this session — can re-establish the link without
    /// re-pairing. Sets `userClosed` so `ContentView`'s auto-reconnect does not immediately undo this.
    /// Callers must NOT pair this with `connectionStore.clear()` the way `disconnect()`'s UI call sites
    /// do — that would defeat the point of keeping the pairing.
    func closeConnection() {
        userClosed = true
        // An intentional close shouldn't make the next manual Reconnect inherit a climbed backoff.
        reconnectAttempt = 0
        disconnect(clearDirect: false)
    }

    private func disconnect(clearDirect: Bool) {
        reconnectTask?.cancel()
        reconnectTask = nil
        if clearDirect { directIP = nil; directPIN = nil }
        liveSinks.forEach { $0.handleChatError(commandId: nil) }
        invalidateSocket()
        connectionStatus = .disconnected
    }

    /// Close the clients and invalidate in-flight connects.
    private func invalidateSocket() {
        connectionGeneration += 1
        v1Client?.close()
        v1Client = nil
        connectingV1?.close()
        connectingV1 = nil
        reads.reset()
    }

    private func scheduleReconnect(retryAfterMs: Int? = nil) {
        // Only the address is required: after the first pairing the PIN is gone (the host rotated it) and
        // the token in `ConnectionStore` is the credential `connect` presents.
        guard let ip = directIP else { return }
        let pin = directPIN ?? ""
        guard reconnectTask == nil else { return }
        // Show "connecting" rather than a false "disconnected" while auto-retrying.
        connectionStatus = .connecting
        // First retry is immediate, then back off.
        let delay = HostApiBackoff.delayMs(attempt: reconnectAttempt, retryAfterMs: retryAfterMs)
        reconnectAttempt += 1
        reconnectTask = Task { @MainActor in
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            }
            guard !Task.isCancelled, self.directIP != nil else { return }
            self.reconnectTask = nil
            self.connect(ip: ip, pin: pin)
        }
    }
}

// MARK: — Store context

extension ConnectionService: ChatHostContext {
    var isConnected: Bool { connectionStatus == .connected }
    var selectedProjectId: String? { projectsStore?.selectedId }

    /// The project a scoped frame should name, waiting for the first `projects.list` reply when the picker is
    /// still loading. Without this the first snapshot/send went out with no project and ran under the team
    /// grant even though a project was remembered. Offline keeps the seeded choice.
    func scopedProjectId() async -> String? {
        guard isConnected, let projects = projectsStore else { return selectedProjectId }
        if !projects.state.loaded { projects.refresh() }
        return await projects.projectIdForScopedFrame()
    }

    func noteProjectRefusal(_ error: Error) -> Bool { projectsStore?.noteRefusal(error) == true }
}
