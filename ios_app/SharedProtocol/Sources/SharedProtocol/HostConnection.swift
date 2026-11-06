import Foundation

public enum HostConnectionState: Sendable, Equatable { case disconnected, connecting, connected }

/// The first credential a connect presents: a pairing PIN, or the device token a host issued for it.
public enum HostCredential: Sendable, Equatable { case pin(String), token(String) }

/// What a host pushes to the client, in Host API v1 vocabulary whichever wire carried it.
public enum HostEvent: Sendable, Equatable {
    /// A v1 event. Decode `payload` with its generated `HostApi…Event` type.
    case event(HostApiEvent, payload: Data, replyTo: String?)
    /// The served capability set changed (`host.capabilities`).
    case capabilities(Set<String>)
    /// An event `rev` skipped ahead (spec "Wire envelope"): discard stale feature state and re-snapshot
    /// the visible screens instead of guessing.
    case resync
    /// The host closed, or the socket died, after `connect` succeeded. `reason.code` is `auth_failed`
    /// (removed on the host, not retryable) or `host_unreachable` (retryable).
    case disconnected(reason: HostApiRejection)
}

/// The transport a store speaks (spec phase 4), implemented by `HostApiV1Client` (and test fakes).
/// Connecting is deliberately not on the protocol: hello + auth report an outcome, and only
/// `ConnectionService` connects, through the concrete type.
@MainActor
public protocol HostConnection: AnyObject {
    /// The Host API version spoken (1).
    var apiVersion: Int { get }
    var state: HostConnectionState { get }
    var capabilities: Set<String> { get }
    /// One consumer (`ConnectionService`) routes events to the stores.
    var onEvent: ((HostEvent) -> Void)? { get set }
    /// Send one command and await its result (JSON matching the command's result schema). `id` lets the
    /// caller own correlation, which chat needs because events carry it back as `replyTo`; nil mints one.
    /// Throws `HostApiRejection`: the host's error frame, or `host_unreachable` (retryable only if the
    /// command is idempotent) when no reply comes.
    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data
    func close()
}

public extension HostConnection {
    func send<P: Encodable, R: Decodable>(_ command: HostApiCommand, _ payload: P, id: String? = nil,
                                          as: R.Type) async throws -> R {
        let result = try await send(command, payload: try JSONEncoder().encode(payload), id: id)
        return try JSONDecoder().decode(R.self, from: result)
    }
}
