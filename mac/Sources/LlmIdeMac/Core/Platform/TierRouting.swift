import Foundation
import os.log

private let tierRoutingLogger = Logger(subsystem: "com.llmide.macapp", category: "TierRouting")

/// A cost tier a role can be routed to. Each tier names one provider + model
/// in Settings; roles (`RoutedFeature`) pick a tier, not a model, so a price
/// change is one edit instead of six.
enum RoutingTier: String, CaseIterable, Identifiable {
    case strong, standard, cheap

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .strong:   return "Strong"
        case .standard: return "Standard"
        case .cheap:    return "Cheap"
        }
    }
}

/// A role whose provider + model can be routed by tier. The raw values are the
/// wire keys of `features` in `POST /kb/routing-tiers` — do not rename.
enum RoutedFeature: String, CaseIterable, Identifiable {
    case subagents, loop, autoTasks, quickChat, pipeline, `internal`

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .subagents: return "Plugin subagents"
        case .loop:      return "Loop (agent steps, regression replay)"
        case .autoTasks: return "Auto Tasks"
        case .quickChat: return "Quick chat & phone"
        case .pipeline:  return "Server pipeline (plan, codegen)"
        case .internal:  return "Internal helpers (summaries, classify)"
        }
    }
}

/// One tier's target: the server wire provider id
/// (`anthropic | openai | google | deepseek | custom:<uuid>`) and a model id.
struct TierRoute: Codable, Equatable {
    var provider: String
    var model: String
}

/// The whole routing table. Keys are raw values of `RoutingTier` /
/// `RoutedFeature`; strings rather than enums so an entry written by a newer
/// build (an unknown tier/feature) decodes instead of failing the whole table.
/// Mirrored verbatim to the server as the body of `POST /kb/routing-tiers`.
struct TierRoutingConfig: Codable, Equatable {
    var tiers: [String: TierRoute] = [:]
    var features: [String: String] = [:]

    static let defaultsKey = "tierRouting"

    init(tiers: [String: TierRoute] = [:], features: [String: String] = [:]) {
        self.tiers = tiers
        self.features = features
    }

    /// Tolerant: a missing half decodes as empty, so a partial blob never
    /// reads as "no routing" for the half that is present.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tiers = try container.decodeIfPresent([String: TierRoute].self, forKey: .tiers) ?? [:]
        features = try container.decodeIfPresent([String: String].self, forKey: .features) ?? [:]
    }

    func tier(_ tier: RoutingTier) -> TierRoute? { tiers[tier.rawValue] }

    func tier(for feature: RoutedFeature) -> RoutingTier? {
        features[feature.rawValue].flatMap(RoutingTier.init(rawValue:))
    }

    /// Read the stored table. An absent or unreadable blob is an empty table:
    /// routing is an optimization, and an empty table is exactly today's
    /// behaviour, so a decode failure must never block a run.
    static func load(from defaults: UserDefaults = .standard) -> TierRoutingConfig {
        guard let data = defaults.data(forKey: defaultsKey) else { return TierRoutingConfig() }
        do {
            return try JSONDecoder().decode(TierRoutingConfig.self, from: data)
        } catch {
            tierRoutingLogger.error("Unreadable \(defaultsKey, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return TierRoutingConfig()
        }
    }

    @discardableResult
    func save(to defaults: UserDefaults = .standard) -> Bool {
        do {
            defaults.set(try JSONEncoder().encode(self), forKey: Self.defaultsKey)
            return true
        } catch {
            tierRoutingLogger.error("Encoding \(Self.defaultsKey, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}

/// One tier as the SERVER sees it (`GET /kb/routing-tiers`, API v67+):
/// whether its resolver would run the tier (vault keys, synced custom
/// providers — state the Mac cannot see) and whether the Agent SDK engine can.
struct TierServerStatus: Codable, Equatable, Sendable {
    var usable: Bool
    var reason: String?
    var agentCapable: Bool
    var agentReason: String?
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
final class TierRoutingServerCache: @unchecked Sendable {
    static let shared = TierRoutingServerCache()
    private let lock = NSLock()
    private var value = TierRoutingServerState.unknown

    var state: TierRoutingServerState {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// Resolves a role to a concrete provider + model, or nil for "use the
/// caller's default". Never throws and never errors: an unset or unusable tier
/// silently means today's code path (the spec's "normal use never errors
/// because of routing"); Settings shows why via `unusableReason`.
enum TierRouting {
    /// Server API the Mac requires before ANY route is used. v66 added
    /// `provider` on /kb/loop/agent-run (an older server ignores it but honours
    /// `model`, sending a GLM id to Anthropic); v67 added the status endpoint
    /// the resolver consults. One gate for both, so below v67 every resolve is
    /// nil — today's behaviour.
    static let requiredServerApiVersion = 67

    /// Same shape as `QuickChatContext.serverSupportsAsk`: unknown fails closed.
    static func serverSupportsRouting(_ apiVersion: Int?) -> Bool {
        guard let apiVersion else { return false }
        return apiVersion >= requiredServerApiVersion
    }

    /// Built-in wire provider ids a tier may name, in menu order.
    static let builtInProviders: [(wireId: String, tool: AICliTool)] = [
        (ClaudeCLI.provider, .claudeCode),
        ("openai", .openai),
        ("google", .gemini),
        ("deepseek", .deepseek),
    ]

    /// The local CLI that runs `provider`'s models, or nil when it has none
    /// (DeepSeek, every custom provider). Auto Tasks run a CLI subprocess, so
    /// only these can take an Auto Task route.
    static func cliTool(forProvider provider: String) -> AICliTool? {
        switch provider {
        case ClaudeCLI.provider: return .claudeCode
        case "openai":           return .openai
        case "google":           return .gemini
        default:                 return nil
        }
    }

    static func customProviderId(_ provider: String) -> String? {
        guard provider.hasPrefix("custom:") else { return nil }
        let id = String(provider.dropFirst("custom:".count))
        return id.isEmpty ? nil : id
    }

    /// Why `route` cannot be used under these constraints, or nil when it can.
    /// Pure over its inputs so tests need no UserDefaults.
    ///
    /// - Parameters:
    ///   - requiresAgentEngine: the turn runs on the Claude Agent (v2) engine,
    ///     which speaks the Anthropic Messages API only — first-party
    ///     Anthropic or a custom provider with an Anthropic-compatible URL.
    ///   - localCLIOnly: the work is a local CLI subprocess (Auto Tasks).
    ///   - cliInstalled: whether a local CLI tool's executable can be found;
    ///     consulted only with `localCLIOnly`.
    static func unusableReason(_ route: TierRoute, customProviders: [CustomProvider],
                               requiresAgentEngine: Bool = false, localCLIOnly: Bool = false,
                               cliInstalled: (AICliTool) -> Bool = { _ in true }) -> String? {
        if route.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "no model chosen"
        }
        if let customId = customProviderId(route.provider) {
            guard let custom = customProviders.first(where: { $0.id == customId }) else {
                return "its provider was deleted"
            }
            guard custom.isEnabled else { return "\(custom.name) is disabled" }
            if localCLIOnly { return "\(custom.name) has no local CLI" }
            if requiresAgentEngine && !custom.canRunAgentEngine {
                return "\(custom.name) has no Anthropic-compatible URL for the Agent engine"
            }
            return nil
        }
        guard let builtIn = builtInProviders.first(where: { $0.wireId == route.provider }) else {
            return "unknown provider \(route.provider)"
        }
        if localCLIOnly {
            guard let tool = cliTool(forProvider: route.provider) else {
                return "\(builtIn.tool.displayName) has no local CLI"
            }
            if !cliInstalled(tool) {
                return "the `\(tool.cliExecutable)` CLI is not installed"
            }
        }
        // WHY: mirrors AgentV2Selection.agentCapableProviders. A non-Anthropic
        // built-in on a v2 chat would drop that turn to the classic engine,
        // breaking the per-chat engine cut.
        if requiresAgentEngine && route.provider != ClaudeCLI.provider {
            return "\(builtIn.tool.displayName) can't run on the Agent engine"
        }
        return nil
    }

    /// Why the SERVER side rules `tier` out, or nil. Below API v67 (or before
    /// the server answered) nothing routes. A local-CLI role (Auto Tasks)
    /// never reaches the server's resolver, so only the version gate applies
    /// to it; every other role needs the server to have reported the tier
    /// usable — and Agent-engine capable when the turn runs on that engine.
    static func serverUnusableReason(_ tier: RoutingTier, server: TierRoutingServerState,
                                     requiresAgentEngine: Bool = false,
                                     localCLIOnly: Bool = false) -> String? {
        guard serverSupportsRouting(server.apiVersion) else {
            return server.apiVersion.map { "the server is API v\($0); tier routing needs v\(requiredServerApiVersion)" }
                ?? "the server's API version is not known yet"
        }
        if localCLIOnly { return nil }
        guard let status = server.status?[tier.rawValue] else {
            return "the server has not reported this tier's status yet"
        }
        if !status.usable { return "the server can't run it (\(describeServerReason(status.reason)))" }
        if requiresAgentEngine && !status.agentCapable {
            return "the server can't run it on the Agent engine (\(describeServerReason(status.agentReason)))"
        }
        return nil
    }

    /// Human wording for the server's reason codes (providers/tier-routing.mjs).
    static func describeServerReason(_ code: String?) -> String {
        switch code {
        case "no_key":            return "no API key stored on the server — add one in Model Providers"
        case "not_found":         return "the server doesn't know this custom provider — re-save it in Custom Providers"
        case "disabled":          return "the provider is disabled"
        case "not_agent_capable": return "only Claude or a custom provider with an Anthropic-compatible URL can"
        case "unset":             return "the tier is not set on the server — it has not synced yet"
        case let other?:          return other
        case nil:                 return "unknown reason"
        }
    }

    /// Pure resolver: the feature's tier route when one is set and usable both
    /// locally and on the server.
    static func resolve(feature: RoutedFeature, config: TierRoutingConfig,
                        customProviders: [CustomProvider], server: TierRoutingServerState,
                        requiresAgentEngine: Bool = false, localCLIOnly: Bool = false,
                        cliInstalled: (AICliTool) -> Bool = { _ in true }) -> TierRoute? {
        guard let tier = config.tier(for: feature), let route = config.tier(tier) else { return nil }
        let reason = serverUnusableReason(tier, server: server, requiresAgentEngine: requiresAgentEngine,
                                          localCLIOnly: localCLIOnly)
            ?? unusableReason(route, customProviders: customProviders,
                              requiresAgentEngine: requiresAgentEngine, localCLIOnly: localCLIOnly,
                              cliInstalled: cliInstalled)
        if let reason {
            // NOTE: logged so a silent fallback to a pricier default is visible.
            tierRoutingLogger.info("Route \(feature.rawValue, privacy: .public)→\(tier.rawValue, privacy: .public) uses default: \(reason, privacy: .public)")
            return nil
        }
        return route
    }

    /// `resolve` over the persisted table, custom providers and this launch's
    /// server state — what production callers use, at the moment they build a
    /// request.
    static func resolve(feature: RoutedFeature, requiresAgentEngine: Bool = false,
                        localCLIOnly: Bool = false) -> TierRoute? {
        resolve(feature: feature, config: .load(), customProviders: CustomProvider.loadAll(),
                server: TierRoutingServerCache.shared.state,
                requiresAgentEngine: requiresAgentEngine, localCLIOnly: localCLIOnly,
                cliInstalled: isCLIInstalled)
    }

    // MARK: - Local CLI presence

    /// Whether `tool`'s executable can be found: the inherited PATH plus the
    /// user CLI folders a Finder-launched app's PATH lacks
    /// (`ProjectRuntimeEnvironment.cliDirectories`). Lenient on purpose — a
    /// false "missing" only costs the route, never the run.
    static func isCLIInstalled(_ tool: AICliTool) -> Bool {
        guard let name = tool.cliExecutable.split(separator: " ").first.map(String.init),
              !name.isEmpty else { return false }
        let fm = FileManager.default
        if name.hasPrefix("/") { return fm.isExecutableFile(atPath: name) }
        let home = fm.homeDirectoryForCurrentUser.path
        let inherited = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let extra = ProjectRuntimeEnvironment.cliDirectories.map {
            $0.hasPrefix("/") ? $0 : (home as NSString).appendingPathComponent($0)
        }
        return (inherited + extra).contains { directory in
            let candidate = (directory as NSString).appendingPathComponent(name)
            var isDirectory: ObjCBool = false
            return fm.fileExists(atPath: candidate, isDirectory: &isDirectory)
                && !isDirectory.boolValue && fm.isExecutableFile(atPath: candidate)
        }
    }

    // MARK: - Server sync + status

    /// Bring this launch's server state up to date for `serverApiVersion`:
    /// below v67 (or unknown) it only records that — no network, nothing
    /// routes; otherwise it re-syncs custom providers (the server's status
    /// depends on them), pushes the table, and fetches the per-tier status.
    /// A failed fetch leaves status nil (fail closed). Returns the new state;
    /// throws only the table push/fetch error, for Settings to show.
    @discardableResult
    static func refreshServerState(api: LlmIdeAPIClient, serverApiVersion: Int?,
                                   config: TierRoutingConfig = .load()) async throws -> TierRoutingServerState {
        guard serverSupportsRouting(serverApiVersion) else {
            let state = TierRoutingServerState(apiVersion: serverApiVersion, status: nil)
            TierRoutingServerCache.shared.state = state
            return state
        }
        do {
            try await CustomProvider.syncAllToBackendThrowing(api: api)
        } catch {
            // Not fatal: the status below then reports custom tiers as the
            // server sees them, which is what routing must follow anyway.
            tierRoutingLogger.error("Custom provider sync before tier status failed: \(error.localizedDescription, privacy: .public)")
        }
        do {
            let dropped = try await api.syncTierRouting(config)
            let status = try await api.fetchTierRoutingStatus()
            let state = TierRoutingServerState(apiVersion: serverApiVersion, status: status, dropped: dropped)
            TierRoutingServerCache.shared.state = state
            return state
        } catch {
            TierRoutingServerCache.shared.state = TierRoutingServerState(apiVersion: serverApiVersion, status: nil)
            throw error
        }
    }

    /// Fire-and-forget `refreshServerState` (app lifecycle hooks); failures
    /// are logged and leave routing off.
    static func refreshServerStateInBackground(api: LlmIdeAPIClient, serverApiVersion: Int?) {
        Task {
            do {
                try await refreshServerState(api: api, serverApiVersion: serverApiVersion)
            } catch {
                tierRoutingLogger.error("Tier routing status refresh failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Sign-out: the status belongs to the previous user.
    static func resetServerState() {
        TierRoutingServerCache.shared.state = .unknown
    }

    /// The narrow set of server refusals that mean "this route's provider can't
    /// run" (never a generic failure): a routed call that hits one is retried
    /// once without the route — today's request.
    static let providerConfigErrorCodes: Set<String> = ["PROVIDER_UNAVAILABLE", "PROVIDER_NOT_AGENT_CAPABLE"]

    static func isProviderConfigError(_ error: Error) -> Bool {
        guard case APIError.http(let status, let code, _, _) = error else { return false }
        return status == 400 && providerConfigErrorCodes.contains(code)
    }
}
