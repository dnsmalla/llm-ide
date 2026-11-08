import Foundation

/// The client's view of the host's `rev` (spec "Wire envelope"). Responses carry the host's current rev
/// and set a baseline; an event more than one past it is a gap, and the client re-snapshots.
public struct HostApiRevTracker: Sendable, Equatable {
    public enum Decision: Sendable, Equatable { case inOrder, gap }
    public private(set) var rev: Int?
    public init() {}

    public mutating func baseline(_ r: Int) { rev = max(rev ?? r, r) }

    public mutating func observe(event r: Int) -> Decision {
        defer { rev = max(rev ?? r, r) }
        guard let last = rev else { return .gap }
        // r > last guarantees r - 1 cannot overflow; r - last could (Int.min baseline). The rev is untrusted input.
        return r > last && r - 1 > last ? .gap : .inOrder
    }

    public mutating func reset() { rev = nil }
}

/// One connect attempt's hello/auth steps. `.unreachable` means no v1 host answered (silence, or a host that
/// does not speak this version); the caller backs off and retries. After a v1 answer, every refusal is final
/// for that attempt.
public struct HostApiNegotiation: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case idle, awaitingHello, awaitingAuth, v1, noHost, failed }
    public enum Input: Sendable, Equatable {
        case start(v1Endpoint: Bool)
        case helloAnswered(apiVersion: Int, requiresAuth: Bool)
        case helloRefused(HostApiRejection)
        /// No valid v1 frame in time, or the socket failed.
        case silent
        case authAnswered
        case authRefused(HostApiRejection)
    }
    public enum Action: Sendable, Equatable { case openV1AndHello, sendAuth, ready, unreachable, fail(HostApiRejection), ignore }

    public private(set) var phase: Phase = .idle
    public init() {}

    public mutating func handle(_ input: Input) -> Action {
        switch (phase, input) {
        case (.idle, .start(let v1)):
            phase = v1 ? .awaitingHello : .noHost
            return v1 ? .openV1AndHello : .unreachable
        case (.awaitingHello, .helloAnswered(let version, let requiresAuth)):
            guard version == HostApi.version else { phase = .noHost; return .unreachable }
            phase = requiresAuth ? .awaitingAuth : .v1
            return requiresAuth ? .sendAuth : .ready
        case (.awaitingHello, .helloRefused(let r)):
            // A host that does not speak our version: nothing to sign in to here.
            if r.code == "capability_unavailable" || r.code == "unknown_command" { phase = .noHost; return .unreachable }
            phase = .failed
            return .fail(r)
        case (.awaitingHello, .silent):
            phase = .noHost
            return .unreachable
        case (.awaitingAuth, .authAnswered):
            phase = .v1
            return .ready
        case (.awaitingAuth, .authRefused(let r)):
            phase = .failed
            return .fail(r)
        case (.awaitingAuth, .silent):
            phase = .failed
            return .fail(HostApiRejection(replyTo: nil, code: "host_unreachable",
                                          message: "The host stopped answering during sign-in.", retryable: true))
        default:
            return .ignore
        }
    }
}

/// What a failed v1 attempt may do to the phone's pairing. A transient outage or a non-auth refusal must
/// never unpair it (Task 5 review I1, I2).
public extension HostApiNegotiation {
    /// A non-retryable `auth_failed` is an expired or revoked device session: the 90-day limit, a revoke on the
    /// desktop, or a wiped registry. It is the only refusal that clears the phone's saved credentials.
    static func isExpiredSession(_ r: HostApiRejection) -> Bool { r.code == "auth_failed" && !r.retryable }

    /// Only the host saying the device is not paired clears the credentials.
    static func clearsCredentials(_ r: HostApiRejection) -> Bool { isExpiredSession(r) }

    /// Shown when the saved device token is past its lifetime or the host no longer knows it. Re-pairing is the
    /// only path, so the pairing screen offers it directly instead of a generic connection error.
    static let rePairMessage = "This iPhone's pairing has expired or was removed. Pair again with the desktop's QR or a new PIN."
}

/// Where to reach a Host API v1 listener. Spec "Security": `wss://` to any host (pinned, `HostApiPinning`),
/// plaintext `ws://` only on loopback (the DEBUG dev listener).
public struct HostApiEndpoint: Sendable, Equatable {
    public let url: URL
    public var isTLS: Bool { url.scheme == "wss" }
    static let loopback: Set<String> = ["127.0.0.1", "localhost", "[::1]"]

    public init?(_ string: String) {
        guard var c = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), c.port != nil else { return nil }
        guard scheme == "wss" || (scheme == "ws" && Self.loopback.contains(host)) else { return nil }
        guard c.query == nil, c.fragment == nil, c.user == nil, c.password == nil,
              ["", "/", "/host-api/v1"].contains(c.path) else { return nil }
        c.path = "/host-api/v1"
        c.scheme = scheme; c.host = host   // normalised to lowercase
        guard let url = c.url else { return nil }
        self.url = url
    }
}

/// When the phone ends a chat turn itself because no host event will (Task 6 review I1).
public enum HostApiChatTurn {
    /// After Stop: a host that cancelled nothing (`cancelled: false`) or never answered (nil) emits no
    /// `chat.error`, so the turn ends locally.
    public static func endsAfterCancel(cancelled: Bool?) -> Bool { cancelled != true }
}

/// Makes a v1 `chat.send` from what the phone's composer allows, so the user never meets a schema error
/// (final review I2). The limits equal `commands.json` `chat.send`; `HostApiChatSendPolicyTests` pins them.
public enum HostApiChatSendPolicy {
    public static let maxTextUTF16 = 100_000, maxAttachments = 10, maxAttachmentTextUTF16 = 100_000, maxNameUTF16 = 300
    public static let fileTooLarge = "That file is too large to send to this computer."
    public static let tooManyFiles = "You can attach up to \(maxAttachments) files to one message."
    public static let textTooLong = "That message is too long to send to this computer."

    public enum Outcome: Sendable, Equatable { case send(HostApiChatSendRequest), refuse(String) }

    /// A files-only message (v1 `text` needs minLength 1) carries the file names as its text.
    /// `projectId` scopes the frame; nil keeps the v1 team behavior.
    public static func request(text: String, files: [ChatFileText], projectId: String? = nil) -> Outcome {
        guard files.count <= maxAttachments else { return .refuse(tooManyFiles) }
        guard files.allSatisfy({ $0.text.utf16.count <= maxAttachmentTextUTF16 }) else { return .refuse(fileTooLarge) }
        let names = files.map { $0.name.isEmpty ? "file" : HostApiFrame.clamp($0.name, maxUTF16: maxNameUTF16) }
        let body = text.isEmpty ? "Attached: " + names.joined(separator: ", ") : text
        guard !body.isEmpty, body.utf16.count <= maxTextUTF16 else { return .refuse(textTooLong) }
        let attachments = zip(names, files).map { HostApiChatSendRequestAttachmentsItem(name: $0, text: $1.text) }
        let request = HostApiChatSendRequest(attachments: attachments.isEmpty ? nil : attachments,
                                             projectId: projectId, text: body)
        // Together the files can still pass the 1 MiB frame cap; 4 KiB is left for the envelope.
        guard let bytes = try? JSONEncoder().encode(request).count,
              bytes <= HostApi.limits.maxFrameBytes - 4096 else { return .refuse(fileTooLarge) }
        return .send(request)
    }
}

/// The phone's reconnect delay: immediate first, then 2 s × 1.5ⁿ up to 30 s. A host's `retryAfterMs` (a PIN
/// lockout, a throttle) stretches it, capped at 5 minutes so a bad value cannot park the phone (final M1).
public enum HostApiBackoff {
    public static func delayMs(attempt: Int, retryAfterMs: Int? = nil) -> Int {
        // The exponent is clamped: an unbounded one overflowed Int after ~100 failed attempts.
        let backoff = attempt <= 0 ? 0 : min(2_000 * Int(pow(1.5, Double(min(attempt - 1, 10)))), 30_000)
        guard let wait = retryAfterMs, wait > 0 else { return backoff }
        return max(backoff, min(wait, 300_000))
    }
}

/// Chat-slice texts and decisions.
public enum HostApiChatNotices {
    /// Shown when the host withdraws `tool_approvals` while a tool card is up (Task 6 review M1).
    public static let toolApprovalsOff = "Tool requests can no longer be approved from the phone."
    public static let chatOff = "Chat from this phone was turned off on your computer."

    /// Shown above a disabled composer when a connected host does not offer chat (nil capabilities = all).
    public static func composer(connected: Bool, capabilities: Set<String>?) -> String? {
        guard connected, let capabilities, !capabilities.contains(HostApiCommand.chatSend.capability) else { return nil }
        return chatOff
    }

    /// Only a local encode failure drops the connection (as before the transport move). A host refusal,
    /// `internal` included, or an unreadable reply ends the turn and keeps the address (Task 6 review M5).
    public static func disconnectsAfterSendFailure(_ error: Error) -> Bool { error is EncodingError }
}
