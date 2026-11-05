import Foundation
import SharedProtocol

enum HostApiQuickChatHistory: Equatable { case lines([MobileChatLine]), unavailable(String) }
enum HostApiQuickChatClear: Equatable { case cleared, denied(String), unavailable(String) }

/// Host API v1 on the Mac: per-connection sessions, auth, `rev`, and the 12 commands. Chat and approvals
/// run through the manager's existing v2 handlers (`forward`), so v1 inherits the tier gate, Phone Access
/// switches and approval rules; their replies come back through `deliver` and `HostApiV2Translator`.
@MainActor
final class HostApiV1Gateway {
    struct Dependencies {
        var hostName: () -> String
        var validatePin: (String) -> Bool
        var pinConsumed: () -> Void
        var issueToken: (_ deviceId: String, _ name: String, _ scopes: [String]) -> String
        var authenticate: (_ token: String) -> String?
        var scopes: (_ deviceId: String) -> [String]
        var revoke: (_ deviceId: String) -> Void
        var capabilities: () -> [String]
        var tierRefusal: (_ v2Type: String) -> String?
        var forward: (_ v2Frame: Data) -> Void
        var history: (_ limit: Int) async -> HostApiQuickChatHistory
        var clear: () async -> HostApiQuickChatClear
        var cancel: (_ internalCommandId: String) -> Void
        var log: (String) -> Void
        /// The pinned TLS identity's fingerprint; nil on the plaintext development listener (field omitted).
        var certificateFingerprint: () -> String?
        /// Audit sink (`HostApiV1AuditLog.record`). Never pass a token, PIN or frame text.
        var audit: (_ event: String, _ peer: String, _ deviceId: String?, _ detail: String?, _ dedupeKey: String?) -> Void = { _, _, _, _, _ in }
        var now: () -> Date = { Date() }
        /// The PIN throttle; the manager passes the one its v2 server uses, so both paths share one budget.
        var pinThrottle = LockedPairingThrottle()
    }

    static let maxSessions = 4
    static let authDeadline: TimeInterval = 10
    /// The desktop's `MAX_UNAUTHENTICATED_PER_PEER`: one peer (IPv6 /64) cannot hold every slot before auth.
    static let maxUnauthenticatedPerPeer = 2

    var send: (_ session: Int, _ frame: Data) -> Void = { _, _ in }
    var close: (_ session: Int) -> Void = { _ in }

    private let deps: Dependencies
    private var sessions: [Int: (state: HostApiV1Session, peer: String, rev: Int)] = [:]
    /// internal command id → (session, external id, cancelled by the client)
    private var owned: [String: (session: Int, external: String, cancelled: Bool)] = [:]
    // Separate buckets: a wrong PIN must not delay a token reconnect from the same peer, nor the reverse.
    // The PIN bucket is shared with the v2 link (deps.pinThrottle); the token bucket is v1's own.
    private var pairThrottle: LockedPairingThrottle { deps.pinThrottle }
    private let tokenThrottle = LockedPairingThrottle()
    private var rate = HostApiV1RateLimiter()
    /// Per authed session: the capabilities its token was granted, and the effective list it was last sent.
    private var grants: [Int: Set<String>] = [:]
    private var lastSent: [Int: [String]] = [:]
    /// Set by `closeAll()`: events still buffered in the stream after a stop must not pair, mint or rotate the PIN.
    private var stopped = false

    init(dependencies: Dependencies) { self.deps = dependencies }

    static func capabilities(chatInstalled: Bool, toolApprovals: Bool) -> [String] {
        var caps = ["host"]
        if chatInstalled { caps += ["chat", "approvals"] }
        if chatInstalled && toolApprovals { caps.append("tool_approvals") }
        return caps
    }

    // MARK: - Connections

    func opened(session: Int, peer: String) {
        guard !stopped else { return close(session) }
        let key = PairingThrottle.peerKey(peer)
        let pending = sessions.values.filter { $0.state.deviceId == nil && PairingThrottle.peerKey($0.peer) == key }.count
        let why = sessions.count >= Self.maxSessions ? "This Mac already has the maximum number of Host API connections."
            : pending >= Self.maxUnauthenticatedPerPeer ? "This device already has connections waiting to sign in — finish or close one first." : nil
        if let why {
            send(session, HostApiFrame.error(replyTo: nil, code: "busy", message: why, retryable: true, rev: 0))
            close(session)
            return
        }
        sessions[session] = (HostApiV1Session(), peer, 0)
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.authDeadline * 1_000_000_000))
            guard let self, let s = self.sessions[session], s.state.deviceId == nil else { return }
            self.deps.log("Host API v1 connection \(session) did not authenticate in time — closing")
            self.close(session)
            self.closed(session: session)
        }
    }

    func closed(session: Int) {
        sessions.removeValue(forKey: session)
        rate.drop(session: session)
        grants.removeValue(forKey: session)
        lastSent.removeValue(forKey: session)
        for (id, o) in owned where o.session == session {
            owned.removeValue(forKey: id)
            deps.cancel(id)
        }
    }

    func disconnect(deviceId: String) {
        for (id, s) in sessions where s.state.deviceId == deviceId {
            send(id, HostApiFrame.error(replyTo: nil, code: "auth_failed", message: "This device was removed on the Mac.", retryable: false, rev: s.rev))
            close(id)
            closed(session: id)
        }
    }

    func closeAll() {
        stopped = true
        for id in Array(sessions.keys) {
            close(id)
            closed(session: id)
        }
    }

    /// Each connection has its own monotonic counter (events bump it; responses carry the current value).
    func rev(for session: Int) -> Int? { sessions[session]?.rev }

    func owns(_ internalCommandId: String) -> Bool { owned[internalCommandId] != nil }

    // MARK: - Outbound (from MobileControlManager.emit)

    func deliver(v2Frame: Data, internalCommandId: String) {
        guard let o = owned[internalCommandId], sessions[o.session] != nil else { return }
        let t = HostApiV2Translator.translate(v2Frame, external: o.external, cancelledByClient: o.cancelled)
        for e in t.events { sendEvent(o.session, e.command, raw: e.payload, replyTo: o.external) }
        if t.terminal { owned.removeValue(forKey: internalCommandId) }
    }

    /// A session's capabilities: served ∩ granted, in served order.
    private func effective(_ session: Int) -> [String] {
        deps.capabilities().filter { grants[session]?.contains($0) == true }
    }

    /// `host` is always granted, so the effective list is never empty (schema `minItems: 1`).
    private func grant(_ session: Int, _ scopes: [String]) -> [String] {
        grants[session] = Set(scopes).union(["host"])
        let caps = effective(session)
        lastSent[session] = caps
        return caps
    }

    func capabilitiesChanged() {
        for (id, s) in sessions where s.state.deviceId != nil {
            let caps = effective(id)
            guard caps != lastSent[id] else { continue }
            lastSent[id] = caps
            sendEvent(id, "host.capabilities", payload: HostApiHostCapabilitiesEvent(capabilities: caps))
        }
    }

    // MARK: - Inbound

    func receive(session: Int, data: Data) async {
        guard !stopped, let entry = sessions[session] else { return }
        // The frame bucket runs before any parsing, so a flood costs one regex per frame.
        if let wait = rate.frame(session: session, now: deps.now()) {
            return rateRefused(session, Self.cheapId(data), wait)
        }
        let request: HostApiInboundRequest
        switch HostApiFrame.parseRequest(data) {
        case .success(let r): request = r
        case .failure(let f): return fail(session, f.replyTo, f.code, f.message)
        }
        var served = Set(deps.capabilities())
        if entry.state.deviceId != nil {
            let capability = request.command.capability
            if served.contains(capability) && grants[session]?.contains(capability) != true {
                deps.log("Host API v1 connection \(session) refused \(capability) (not granted)")
                deps.audit("scope_denied", entry.peer, entry.state.deviceId, capability, "\(entry.state.deviceId ?? ""):\(capability)")
                return fail(session, request.id, "denied", "This device was not granted \(capability) — pair again to grant it.")
            }
            served = Set(effective(session))
        }
        if case .refuse(let code, let message) = entry.state.gate(request.command, served: served) {
            return fail(session, request.id, code, message)
        }
        let decoder = JSONDecoder()
        func payload<T: Decodable>(_ t: T.Type) -> T? { try? decoder.decode(T.self, from: request.payload) }
        let id = request.id

        switch request.command {
        case .hostHello:
            guard let p = payload(HostApiHostHelloRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.hello payload.") }
            if let why = HostApiV1Session.helloRefusal(apiVersions: p.apiVersions) { return fail(session, id, "capability_unavailable", why) }
            sessions[session]?.state.greeted(clientName: p.clientName)
            respond(session, id, .hostHello, HostApiHostHelloResult(
                apiVersion: 1, apiVersions: [1], capabilities: deps.capabilities(),
                certificateFingerprint: deps.certificateFingerprint(), hostKind: "mac", hostName: HostApiFrame.clamp(deps.hostName(), maxUTF16: 120),
                protocolVersion: MobileProtocol.protocolVersion, requiresAuth: true))
        case .hostAuthPair:
            guard let p = payload(HostApiHostAuthPairRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.auth.pair payload.") }
            if throttled(session, id, entry.peer, pairThrottle, "pair_throttled") { return }
            guard deps.validatePin(p.pin) else {
                pairThrottle.registerFailure(host: PairingThrottle.peerKey(entry.peer), now: deps.now())
                deps.audit("pair_failed", entry.peer, nil, nil, nil)
                return fail(session, id, "auth_failed", "Wrong PIN.")
            }
            pairThrottle.registerSuccess(host: PairingThrottle.peerKey(entry.peer))
            guard case .awaitingAuth(let name) = entry.state.phase else {
                return fail(session, id, "denied", "This connection is not waiting to pair.")
            }
            let deviceId = MobilePairedDeviceStore.hostApiDevicePrefix + UUID().uuidString
            // The device is granted exactly what is served now; a capability turned on later needs a re-pair.
            let scopes = deps.capabilities()
            let token = deps.issueToken(deviceId, name, scopes)
            deps.pinConsumed()
            sessions[session]?.state.authenticated(deviceId: deviceId)
            deps.audit("pair_ok", entry.peer, deviceId, name, nil)
            respond(session, id, .hostAuthPair, HostApiHostAuthPairResult(capabilities: grant(session, scopes), token: token))
        case .hostAuthToken:
            guard let p = payload(HostApiHostAuthTokenRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.auth.token payload.") }
            if throttled(session, id, entry.peer, tokenThrottle, "token_throttled") { return }
            guard let deviceId = deps.authenticate(p.token) else {
                tokenThrottle.registerFailure(host: PairingThrottle.peerKey(entry.peer), now: deps.now())
                deps.audit("token_failed", entry.peer, nil, nil, nil)
                return fail(session, id, "auth_failed", "This device is no longer paired with this Mac — pair again with the current PIN.")
            }
            tokenThrottle.registerSuccess(host: PairingThrottle.peerKey(entry.peer))
            sessions[session]?.state.authenticated(deviceId: deviceId)
            respond(session, id, .hostAuthToken, HostApiHostAuthTokenResult(capabilities: grant(session, deps.scopes(deviceId))))
        case .hostAuthRevoke:
            guard let p = payload(HostApiHostAuthRevokeRequest.self), let mine = entry.state.deviceId,
                  deps.authenticate(p.token) == mine else { return fail(session, id, "denied", "Only this connection's own token can be revoked here.") }
            deps.revoke(mine)
            deps.audit("revoke_self", entry.peer, mine, nil, nil)
            respond(session, id, .hostAuthRevoke, HostApiHostAuthRevokeResult(revoked: true))
            // Every live session of this device ends, the asking one included (its response is already sent).
            disconnect(deviceId: mine)
        case .hostPing:
            respond(session, id, .hostPing, HostApiHostPingResult())
        case .hostSnapshot:
            guard let p = payload(HostApiHostSnapshotRequest.self) else { return fail(session, id, "invalid_payload", "Bad host.snapshot payload.") }
            guard p.topics.allSatisfy({ $0 == "chat" }) else {
                return fail(session, id, "capability_unavailable", "This Mac serves only the chat snapshot.", hint: "Served topics: chat")
            }
            switch await deps.history(HostApi.limits.defaultListItems) {
            case .unavailable(let m): fail(session, id, "capability_unavailable", m)
            case .lines(let lines):
                let messages = Self.messages(lines, limit: HostApi.limits.defaultListItems)
                    .map { HostApiJSONValue.object(["role": .string($0.role), "content": .string($0.content)]) }
                respond(session, id, .hostSnapshot, HostApiHostSnapshotResult(snapshots: ["chat": .object(["messages": .array(messages)])]))
            }
        case .chatSnapshot:
            let limit = payload(HostApiChatSnapshotRequest.self)?.limit ?? HostApi.limits.defaultListItems
            switch await deps.history(limit) {
            case .unavailable(let m): fail(session, id, "capability_unavailable", m)
            case .lines(let lines): respond(session, id, .chatSnapshot, HostApiChatSnapshotResult(messages: Self.messages(lines, limit: limit)))
            }
        case .chatSend:
            if let wait = rate.turn(deviceId: entry.state.deviceId ?? "", now: deps.now()) { return rateRefused(session, id, wait) }
            guard let p = payload(HostApiChatSendRequest.self) else { return fail(session, id, "invalid_payload", "Bad chat.send payload.") }
            if let why = deps.tierRefusal(MobileProtocol.Tag.llmIdeChat) { return fail(session, id, "denied", why) }
            let internalId = HostApiV1CommandIds.internalId(session: session, external: id)
            guard owned[internalId] == nil else { return fail(session, id, "busy", "That request id is still running.") }
            owned[internalId] = (session, id, false)
            let files = (p.attachments ?? []).map { ChatFileText(name: $0.name, text: $0.text) }
            respond(session, id, .chatSend, HostApiChatSendResult(accepted: true, requestId: id))
            deps.forward((try? JSONEncoder().encode(LlmIdeChat(commandId: internalId, text: p.text, files: files))) ?? Data())
        case .chatCancel:
            let mine = owned.filter { $0.value.session == session }
            for (internalId, _) in mine {
                owned[internalId]?.cancelled = true
                deps.cancel(internalId)
            }
            respond(session, id, .chatCancel, HostApiChatCancelResult(cancelled: !mine.isEmpty))
        case .chatHistoryClear:
            switch await deps.clear() {
            case .cleared: respond(session, id, .chatHistoryClear, HostApiChatHistoryClearResult(cleared: true))
            case .denied(let m): fail(session, id, "denied", m)
            case .unavailable(let m): fail(session, id, "capability_unavailable", m)
            }
        case .approvalsAnswer:
            guard let p = payload(HostApiApprovalsAnswerRequest.self) else { return fail(session, id, "invalid_payload", "Bad approvals.answer payload.") }
            let internalId = HostApiV1CommandIds.internalId(session: session, external: p.commandId)
            guard owned[internalId] != nil else { return fail(session, id, "not_found", "That chat request is not open on this connection.") }
            if let why = deps.tierRefusal(MobileProtocol.Tag.approvalAnswer) { return fail(session, id, "denied", why) }
            respond(session, id, .approvalsAnswer, HostApiApprovalsAnswerResult(accepted: true))
            deps.forward((try? JSONEncoder().encode(ApprovalAnswer(commandId: internalId, requestId: p.requestId, answers: p.answers))) ?? Data())
        case .toolApprovalsAnswer:
            guard let p = payload(HostApiToolApprovalsAnswerRequest.self) else { return fail(session, id, "invalid_payload", "Bad toolApprovals.answer payload.") }
            let internalId = HostApiV1CommandIds.internalId(session: session, external: p.commandId)
            guard owned[internalId] != nil else { return fail(session, id, "not_found", "That chat request is not open on this connection.") }
            if let why = deps.tierRefusal(MobileProtocol.Tag.toolApprovalAnswer) { return fail(session, id, "denied", why) }
            respond(session, id, .toolApprovalsAnswer, HostApiToolApprovalsAnswerResult(accepted: true))
            deps.forward((try? JSONEncoder().encode(ToolApprovalAnswer(commandId: internalId, requestId: p.requestId,
                                                                        allow: p.decision == "allow_once"))) ?? Data())
        case .chatSessions, .chatHistory, .usageGet:
            // Unreachable: the Mac never serves `read`, so the gate refused above. The desktop host serves it.
            fail(session, id, "capability_unavailable", "This Mac does not serve read right now.")
        }
    }

    // MARK: - Helpers

    /// The top-level request id from the frame's head, never a full parse (the desktop's `TOP_LEVEL_ID`): only
    /// scalar envelope members may precede "id", so a payload's nested "id" never matches (nil then).
    private static let topLevelId = try! NSRegularExpression(
        pattern: #"^\s*\{(?:\s*"(?:apiVersion|type|command|ts)"\s*:\s*(?:"[^"\\]*"|[0-9.eE+-]+)\s*,)*\s*"id"\s*:\s*"([^"\\]{1,128})""#)

    nonisolated static func cheapId(_ data: Data) -> String? {
        let head = String(decoding: data.prefix(512), as: UTF8.self) as NSString
        guard let m = topLevelId.firstMatch(in: head as String, range: NSRange(location: 0, length: head.length)) else { return nil }
        return head.substring(with: m.range(at: 1))
    }

    private func rateRefused(_ session: Int, _ replyTo: String?, _ wait: TimeInterval) {
        fail(session, replyTo, "rate_limited", "Too many requests — slow down and try again.", retryable: true,
             retryAfterMs: Int((wait * 1000).rounded(.up)))
        guard rate.refused(session: session), let entry = sessions[session] else { return }
        deps.log("Host API v1 connection \(session) closed after repeated rate refusals")
        deps.audit("rate_closed", entry.peer, entry.state.deviceId, nil, entry.peer)
        close(session)
        closed(session: session)
    }

    /// Consults one pairing throttle; true means the attempt was refused (and audited, de-duplicated per peer).
    /// Every throttle call keys by `peerKey` (IPv6 /64, IPv4-mapped → IPv4), as the desktop's throttle does.
    private func throttled(_ session: Int, _ id: String, _ peer: String, _ throttle: LockedPairingThrottle, _ event: String) -> Bool {
        let key = PairingThrottle.peerKey(peer)
        let d = throttle.decision(for: key, now: deps.now())
        switch d {
        case .allow: return false
        case .wait(let s): fail(session, id, "auth_failed", "Too many attempts — wait a moment and try again.", retryable: true, retryAfterMs: Int(s * 1000))
        case .lockedOut: fail(session, id, "auth_failed", "Too many wrong PINs — locked out for 15 minutes.", retryable: true, retryAfterMs: 15 * 60 * 1000)
        case .serverThrottled: fail(session, id, "auth_failed", "This Mac is refusing new pairings for a few minutes.", retryable: true, retryAfterMs: 60_000)
        }
        let kind: String
        switch d { case .wait: kind = "wait"; case .lockedOut: kind = "lockedOut"; default: kind = "serverThrottled" }
        deps.audit(event, peer, nil, kind, key)
        return true
    }

    static func messages(_ lines: [MobileChatLine], limit: Int) -> [HostApiChatSnapshotResultMessagesItem] {
        let recent = lines.filter { $0.role == "user" || $0.role == "assistant" }
            .suffix(min(max(limit, 1), HostApi.limits.maxListItems))
            .map { HostApiChatSnapshotResultMessagesItem(content: HostApiFrame.clamp($0.content, maxUTF16: 100_000), role: $0.role) }
        // Newest first within maxListBytes (UTF-8 JSON), so the frame stays under maxFrameBytes. The newest message
        // always goes in: clamped to 100k UTF-16 units it is at most ~600 KB even fully escaped, under the budget.
        var bytes = 0
        var start = recent.count
        let encoder = JSONEncoder()
        while start > 0 {
            let size = ((try? encoder.encode(recent[start - 1]))?.count ?? 0) + 1
            if start < recent.count && bytes + size > HostApi.limits.maxListBytes { break }
            bytes += size
            start -= 1
        }
        return Array(recent[start...])
    }

    private func respond<R: Encodable>(_ session: Int, _ replyTo: String, _ command: HostApiCommand, _ result: R) {
        do { send(session, try HostApiFrame.response(replyTo: replyTo, command: command, result: result, rev: rev(for: session) ?? 0)) }
        catch {
            deps.log("Host API v1 \(command.rawValue) result failed validation — sent internal")
            fail(session, replyTo, "internal", "The Mac could not build this reply.")
        }
    }

    private func sendEvent<P: Encodable>(_ session: Int, _ command: String, payload: P, replyTo: String? = nil) {
        sessions[session]?.rev += 1
        do { send(session, try HostApiFrame.event(command, payload: payload, rev: rev(for: session) ?? 0, replyTo: replyTo)) }
        catch { deps.log("Host API v1 \(command) event failed validation — dropped") }
    }

    private func sendEvent(_ session: Int, _ command: String, raw: Data, replyTo: String?) {
        sendEvent(session, command, payload: (try? JSONDecoder().decode(HostApiJSONValue.self, from: raw)) ?? .object([:]), replyTo: replyTo)
    }

    private func fail(_ session: Int, _ replyTo: String?, _ code: String, _ message: String,
                      retryable: Bool = false, retryAfterMs: Int? = nil, hint: String? = nil) {
        send(session, HostApiFrame.error(replyTo: replyTo, code: code, message: message, retryable: retryable,
                                         retryAfterMs: retryAfterMs, hint: hint, rev: rev(for: session) ?? 0))
    }
}
