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

/// One connect attempt's v1-or-v2 decision (spec "Compatibility with MobileProtocol v2"). v2 is chosen only
/// when no v1 host answered. After a v1 answer, every refusal is final for that attempt, so a revoked token
/// can never be hidden by a v2 fallback.
public struct HostApiNegotiation: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case idle, awaitingHello, awaitingAuth, v1, v2, failed }
    public enum Input: Sendable, Equatable {
        case start(v1Endpoint: Bool)
        case helloAnswered(apiVersion: Int, requiresAuth: Bool)
        case helloRefused(HostApiRejection)
        /// No valid v1 frame in time, or the socket failed.
        case silent
        case authAnswered
        case authRefused(HostApiRejection)
    }
    public enum Action: Sendable, Equatable { case openV1AndHello, sendAuth, ready, connectV2, fail(HostApiRejection), ignore }

    public private(set) var phase: Phase = .idle
    public init() {}

    public mutating func handle(_ input: Input) -> Action {
        switch (phase, input) {
        case (.idle, .start(let v1)):
            phase = v1 ? .awaitingHello : .v2
            return v1 ? .openV1AndHello : .connectV2
        case (.awaitingHello, .helloAnswered(let version, let requiresAuth)):
            guard version == HostApi.version else { phase = .v2; return .connectV2 }
            phase = requiresAuth ? .awaitingAuth : .v1
            return requiresAuth ? .sendAuth : .ready
        case (.awaitingHello, .helloRefused(let r)):
            // A host that does not speak our version may still serve v2.
            if r.code == "capability_unavailable" || r.code == "unknown_command" { phase = .v2; return .connectV2 }
            phase = .failed
            return .fail(r)
        case (.awaitingHello, .silent):
            phase = .v2
            return .connectV2
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
    /// After `.connectV2`: take the v2 path only with a v2 credential to present, or no v1 token to lose.
    /// Otherwise an empty v2 `Pairing` earns `auth_failed`, whose credential wipe deletes the v1 token.
    static func fallsBackToV2(hasV1Token: Bool, hasV2Credential: Bool) -> Bool { !hasV1Token || hasV2Credential }

    /// Only the host saying the device is not paired (non-retryable `auth_failed`) clears the credentials.
    static func clearsCredentials(_ r: HostApiRejection) -> Bool { r.code == "auth_failed" && !r.retryable }
}

/// Where to reach a Host API v1 listener. Spec "Security": plaintext only on loopback.
public struct HostApiEndpoint: Sendable, Equatable {
    public let url: URL
    static let loopback: Set<String> = ["127.0.0.1", "localhost", "[::1]"]

    public init?(_ string: String) {
        guard var c = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), c.port != nil else { return nil }
        // shortcut: wss is refused until Plan 6 supplies the certificate-fingerprint evaluator
        // (HostApiTrustEvaluating); a self-signed LAN host must never be trusted unpinned.
        guard scheme == "ws", Self.loopback.contains(host) else { return nil }
        guard c.query == nil, c.fragment == nil, c.user == nil, c.password == nil,
              ["", "/", "/host-api/v1"].contains(c.path) else { return nil }
        c.path = "/host-api/v1"
        c.scheme = scheme; c.host = host   // normalised to lowercase
        guard let url = c.url else { return nil }
        self.url = url
    }
}
