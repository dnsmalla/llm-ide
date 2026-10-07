import Foundation
import os.log

// The server's side of tier routing: what GET /kb/routing-tiers reported, the
// thread-safe cache the resolvers read, and the single serialized refresh path
// that fills it. Split out of TierRouting.swift (GRID 500-line file rule).

/// One tier as the SERVER sees it (`GET /kb/routing-tiers`, API v67+):
/// whether its resolver would run the tier (vault keys, installed provider
/// CLIs, synced custom providers — state the Mac cannot see) and whether the
/// Agent SDK engine can.
struct TierServerStatus: Codable, Equatable, Sendable {
    var usable: Bool
    var reason: String?
    var agentCapable: Bool
    var agentReason: String?
    /// How a usable tier authenticates on the server: "key" (API key) or
    /// "cli" (the provider's logged-in CLI subscription). API v68+; nil from
    /// an older server or on an unusable tier — optional so v67 still decodes.
    var via: String? = nil
}

/// An entry the server dropped from the synced table (`POST` answer, v67+).
struct TierRoutingDropped: Codable, Equatable, Sendable {
    let entry: String
    let reason: String
}

/// What this launch knows about the server's side of tier routing.
///
/// In memory only, on purpose: until the running server has answered (version
/// + status) nothing routes, which is exactly the behaviour before tier
/// routing — a persisted snapshot could vouch for a server that has since
/// been swapped for an older one.
struct TierRoutingServerState: Equatable, Sendable {
    /// `/health.apiVersion` the status was fetched against (nil = unknown).
    var apiVersion: Int?
    /// Per-tier status keyed by `RoutingTier.rawValue`; nil = not fetched.
    var status: [String: TierServerStatus]?
    var dropped: [TierRoutingDropped] = []

    static let unknown = TierRoutingServerState(apiVersion: nil, status: nil)
}

/// Thread-safe holder for this launch's `TierRoutingServerState`; resolvers
/// run on the main actor and off it (Loop runners), so a lock, not an actor.
///
/// Every refresh takes a generation when it is requested; its result is
/// written only while that generation is still the latest, so an older
/// refresh finishing late (or after a sign-out reset) can never overwrite a
/// newer answer.
final class TierRoutingServerCache: @unchecked Sendable {
    static let shared = TierRoutingServerCache()
    private let lock = NSLock()
    private var value = TierRoutingServerState.unknown
    private var generation = 0

    /// Internal (not private) so tests can use a fresh instance.
    init() {}

    var state: TierRoutingServerState {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    /// Claim a new generation; every earlier one becomes stale.
    func nextGeneration() -> Int {
        lock.lock(); defer { lock.unlock() }
        generation += 1
        return generation
    }

    func isLatest(_ candidate: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return candidate == generation
    }

    /// Store `newState` only if `candidate` is still the latest generation.
    /// - Returns: whether it was stored (false = a newer refresh or a reset
    ///   happened meanwhile, and this result is dropped).
    @discardableResult
    func commit(_ newState: TierRoutingServerState, generation candidate: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard candidate == generation else { return false }
        value = newState
        return true
    }

    /// Back to `.unknown` and invalidate every in-flight refresh (sign-out).
    func reset() {
        lock.lock(); defer { lock.unlock() }
        generation += 1
        value = .unknown
    }
}

extension Notification.Name {
    /// Posted (main thread) after `TierRoutingServerCache` stores a new state.
    static let tierRoutingServerStateChanged = Notification.Name("tierRoutingServerStateChanged")
}

/// The ONE path every tier-routing refresh goes through (app lifecycle hooks
/// and the Settings card alike).
///
/// Refreshes run strictly one after another (each waits for the previous), so
/// pushes reach the server in request order and the server ends with the
/// newest table. Each request claims a generation up front: a request that a
/// newer one (or a sign-out reset) has superseded is skipped before it starts,
/// and its result is dropped if it finishes late — the coalescing that keeps a
/// burst of launch-time triggers from storing a stale status. The result is
/// also dropped when the server's version moved while it ran.
@MainActor
enum TierRoutingRefresh {
    enum Outcome {
        case updated(TierRoutingServerState)
        case failed(Error)
        /// A newer refresh, a reset, or a version change made this one moot.
        case superseded
    }

    private static var tail: Task<Void, Never>?

    /// Request a refresh and wait for its outcome.
    ///
    /// - Parameters:
    ///   - serverApiVersion: read when the refresh starts and again before
    ///     storing (the backend's live `serverApiVersion`).
    ///   - config: the table to push; nil = the stored one (never pushed when
    ///     unreadable).
    @discardableResult
    static func request(api: LlmIdeAPIClient, serverApiVersion: @escaping @MainActor () -> Int?,
                        config: TierRoutingConfig? = nil,
                        cache: TierRoutingServerCache = .shared) async -> Outcome {
        let generation = cache.nextGeneration()
        let previous = tail
        let work = Task { @MainActor () -> Outcome in
            await previous?.value
            guard cache.isLatest(generation) else { return .superseded }
            let version = serverApiVersion()
            let fetched: Result<TierRoutingServerState, Error>
            do {
                fetched = .success(try await TierRouting.fetchServerState(api: api, serverApiVersion: version,
                                                                          config: config))
            } catch {
                fetched = .failure(error)
            }
            return finish(fetched, version: version, liveVersion: serverApiVersion(),
                          generation: generation, cache: cache)
        }
        tail = Task { _ = await work.value }
        return await work.value
    }

    /// Fire-and-forget `request` for lifecycle hooks; failures are logged.
    static func requestInBackground(api: LlmIdeAPIClient, serverApiVersion: @escaping @MainActor () -> Int?) {
        Task { @MainActor in
            if case .failed(let error) = await request(api: api, serverApiVersion: serverApiVersion) {
                tierRoutingRefreshLogger.error("Tier routing refresh failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Decide what a finished refresh stores. Pure over its inputs (plus the
    /// cache it commits to) so the stale-drop rules are testable: nothing is
    /// stored when the version moved while it ran or the generation is no
    /// longer the latest; a failure stores "status unknown" (fail closed).
    static func finish(_ fetched: Result<TierRoutingServerState, Error>, version: Int?, liveVersion: Int?,
                       generation: Int, cache: TierRoutingServerCache) -> Outcome {
        guard version == liveVersion else { return .superseded }
        let state: TierRoutingServerState
        switch fetched {
        case .success(let fresh): state = fresh
        case .failure: state = TierRoutingServerState(apiVersion: version, status: nil)
        }
        guard cache.commit(state, generation: generation) else { return .superseded }
        NotificationCenter.default.post(name: .tierRoutingServerStateChanged, object: nil)
        switch fetched {
        case .success(let fresh): return .updated(fresh)
        case .failure(let error): return .failed(error)
        }
    }
}

private let tierRoutingRefreshLogger = Logger(subsystem: "com.llmide.macapp", category: "TierRouting")
