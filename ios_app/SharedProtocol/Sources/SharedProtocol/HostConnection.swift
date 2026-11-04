import Foundation

public enum HostConnectionState: Sendable, Equatable { case disconnected, connecting, connected }

/// The first credential a connect presents: a pairing PIN, or the device token a host issued for it.
public enum HostCredential: Sendable, Equatable { case pin(String), token(String) }

/// What a host pushes to the client, in Host API v1 vocabulary whichever wire carried it.
public enum HostEvent: Sendable, Equatable {
    /// A v1 event. Decode `payload` with its generated `HostApi…Event` type.
    case event(HostApiEvent, payload: Data, replyTo: String?)
    /// v2 only: an `Output{done:false}` status line for request `replyTo`. v1 has no progress event
    /// (Plan 2 decision 2), so a v1 host never sends this.
    case progress(replyTo: String, text: String)
    /// The served capability set changed (`host.capabilities`).
    case capabilities(Set<String>)
    /// An event `rev` skipped ahead (spec "Wire envelope"): discard stale feature state and re-snapshot
    /// the visible screens instead of guessing.
    case resync
    /// The host closed, or the socket died, after `connect` succeeded. `reason.code` is `auth_failed`
    /// (removed on the host, not retryable) or `host_unreachable` (retryable).
    case disconnected(reason: HostApiRejection)
}

/// The transport a store speaks (spec phase 4). The implementations are `HostApiV1Client` and the app's
/// `V2HostConnection`. Connecting is deliberately not on the protocol: v1 runs hello + auth and reports
/// an outcome, while v2 is today's `ConnectionService` pairing and backoff. Only `ConnectionService`
/// connects, through the concrete types.
@MainActor
public protocol HostConnection: AnyObject {
    /// 1 = Host API v1; 2 = the MobileProtocol v2 fallback.
    var apiVersion: Int { get }
    var state: HostConnectionState { get }
    var capabilities: Set<String> { get }
    /// One consumer (`ConnectionService`) routes events to the stores, as its v2 receive loop does today.
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
