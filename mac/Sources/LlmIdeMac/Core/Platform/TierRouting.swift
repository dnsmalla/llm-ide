import Foundation
import os.log

private let tierRoutingLogger = Logger(subsystem: "com.llmide.macapp", category: "TierRouting")

/// A cost tier a role can be routed to. Each tier names one provider + model
/// in Settings; roles (`RoutedFeature`) pick a tier, not a model, so a price
/// change is one edit instead of six. Standard is required and is the
/// default (`TierDefaults`). Public so `chat-contract-lab` can assert the pure
/// logic over it.
public enum RoutingTier: String, CaseIterable, Identifiable, Sendable {
    case strong, standard, cheap

    public var id: String { rawValue }

    var displayName: String {
        switch self {
        case .strong:   return "Strong"
        case .standard: return "Standard"
        case .cheap:    return "Cheap"
        }
    }
}

/// Where a role runs. Decides what "unset" means and whether the server ever
/// sees the role (chat roles never do — `TierDefaults.wireBody`).
public enum RoutedFeatureGroup: String, CaseIterable, Sendable {
    /// The four chat modes: they only pick the MODEL of a chat already on the
    /// tier's provider, so they are Mac-only.
    case chat
    /// Mac surfaces that read `activeCLI` / `defaultModelId` when unset.
    case background
    /// Server-side work; unset keeps the server's built-in default.
    case server

    /// Settings heading for the group.
    public var title: String {
        switch self {
        case .chat:       return "Chat (by mode)"
        case .background: return "Background (this Mac)"
        case .server:     return "Server"
        }
    }
}

/// A role whose provider + model can be routed by tier. The raw values are the
/// wire keys of `features` in `POST /kb/routing-tiers` — do not rename. The
/// `chat*` cases are Mac-only and are stripped from that body.
public enum RoutedFeature: String, CaseIterable, Identifiable, Sendable {
    case subagents, loop, autoTasks, quickChat, pipeline, `internal`
    case chatPlanning, chatCoding, chatReviewing, chatDocuments

    public var id: String { rawValue }

    var displayName: String {
        switch self {
        case .subagents:     return "Plugin subagents"
        case .loop:          return "Loop (agent steps, regression replay)"
        case .autoTasks:     return "Auto Tasks"
        case .quickChat:     return "Quick chat & phone"
        case .pipeline:      return "Server pipeline (plan, codegen)"
        case .internal:      return "Internal helpers (summaries, classify)"
        case .chatPlanning:  return "Chat · Planning"
        case .chatCoding:    return "Chat · Coding"
        case .chatReviewing: return "Chat · Reviewing"
        case .chatDocuments: return "Chat · Documents"
        }
    }

    public var group: RoutedFeatureGroup {
        switch self {
        case .chatPlanning, .chatCoding, .chatReviewing, .chatDocuments: return .chat
        case .loop, .autoTasks, .quickChat:                               return .background
        case .subagents, .pipeline, .internal:                            return .server
        }
    }

    /// What this role runs when no tier is chosen. Mac roles fall back to
    /// `activeCLI` / `defaultModelId`, which Standard's write-through keeps
    /// equal to Standard; server roles keep the server's own default (e.g.
    /// summaries stay on their cheap built-in model).
    public var unsetLabel: String { group == .server ? "Built-in default" : "Standard" }
}


/// What a tier-routed chat turn sends instead when the server refuses its
/// route (400 PROVIDER_UNAVAILABLE / PROVIDER_NOT_AGENT_CAPABLE): the model +
/// provider the surface would have sent without routing. Retried once — see
/// `ChatTransport.roundTripWithRouteFallback`.
struct TierRouteFallback: Sendable, Equatable {
    let model: String?
    let provider: String?
}

/// One tier's target: the server wire provider id
/// (`anthropic | openai | google | deepseek | custom:<uuid>`) and a model id.
public struct TierRoute: Codable, Equatable, Sendable {
    public var provider: String
    public var model: String

    public init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }
}

/// The whole routing table. Keys are raw values of `RoutingTier` /
/// `RoutedFeature`; strings rather than enums so an entry written by a newer
/// build (an unknown tier/feature) decodes instead of failing the whole table.
/// Mirrored verbatim to the server as the body of `POST /kb/routing-tiers`.
public struct TierRoutingConfig: Codable, Equatable, Sendable {
    public var tiers: [String: TierRoute] = [:]
    public var features: [String: String] = [:]

    static let defaultsKey = "tierRouting"

    public init(tiers: [String: TierRoute] = [:], features: [String: String] = [:]) {
        self.tiers = tiers
        self.features = features
    }

    /// Tolerant: a missing half decodes as empty, so a partial blob never
    /// reads as "no routing" for the half that is present.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tiers = try container.decodeIfPresent([String: TierRoute].self, forKey: .tiers) ?? [:]
        features = try container.decodeIfPresent([String: String].self, forKey: .features) ?? [:]
    }

    public func tier(_ tier: RoutingTier) -> TierRoute? { tiers[tier.rawValue] }

    public func tier(for feature: RoutedFeature) -> RoutingTier? {
        features[feature.rawValue].flatMap(RoutingTier.init(rawValue:))
    }

    /// What is stored: a table (absent = empty), or `.unreadable` when a blob
    /// exists but does not decode. Kept apart from `load()` so a sync can
    /// refuse to push — an unreadable blob read as "empty" would make the
    /// server delete the user's table (same reason as
    /// `CustomProvider.LoadOutcome`).
    enum LoadOutcome: Equatable {
        case loaded(TierRoutingConfig)
        case unreadable
    }

    static func loadOutcome(from defaults: UserDefaults = .standard) -> LoadOutcome {
        guard let data = defaults.data(forKey: defaultsKey) else { return .loaded(TierRoutingConfig()) }
        do {
            return .loaded(try JSONDecoder().decode(TierRoutingConfig.self, from: data))
        } catch {
            tierRoutingLogger.error("Unreadable \(defaultsKey, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return .unreadable
        }
    }

    /// Read the stored table for RESOLVING. An absent or unreadable blob is an
    /// empty table: routing is an optimization, and an empty table is exactly
    /// today's behaviour, so a decode failure must never block a run.
    static func load(from defaults: UserDefaults = .standard) -> TierRoutingConfig {
        if case .loaded(let config) = loadOutcome(from: defaults) { return config }
        return TierRoutingConfig()
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

    /// Why the server will not run `feature`'s route although its tier is
    /// usable (API v69+ `featureStatus`), or nil. Today that is only
    /// `cli_untrusted_input` — a keyless codex/gemini tier is never used for
    /// Internal helpers or the Server pipeline. A tier-level refusal is left
    /// to `serverUnusableReason`, so the two never repeat each other.
    static func serverFeatureUnusableReason(_ feature: RoutedFeature, server: TierRoutingServerState) -> String? {
        guard serverSupportsRouting(server.apiVersion),
              let status = server.featureStatus?[feature.rawValue], !status.usable,
              status.reason == "cli_untrusted_input" else { return nil }
        return describeServerReason(status.reason)
    }

    /// Human wording for the server's reason codes (providers/tier-routing.mjs).
    static func describeServerReason(_ code: String?) -> String {
        switch code {
        case "no_key":            return "no API key stored on the server — add one in Model Providers"
        case "no_key_or_cli":     return "no API key on the server and its CLI (codex / gemini) isn't installed "
                                      + "where the server runs — add a key in Model Providers, or install the CLI and log in"
        case "not_found":         return "the server doesn't know this custom provider — re-save it in Custom Providers"
        case "disabled":          return "the provider is disabled"
        case "not_agent_capable": return "only Claude or a custom provider with an Anthropic-compatible URL can"
        case "unset":             return "the tier is not set on the server — it has not synced yet"
        case "cli_unverified":    return "the server hasn't checked its CLI yet — reopen Settings in a moment"
        // The status does not say whether the failure was transient (~1 min)
        // or broken (~10 min), so the wording promises neither.
        case "cli_failed":        return "its CLI failed on the server recently (broken install, logged out or "
                                      + "a temporary error) — it is retried automatically shortly"
        case "route_failed":      return "the provider failed on the server recently — it is retried automatically shortly"
        case "cli_untrusted_input": return "subscription CLIs aren't used for untrusted input; add an API key to route this role"
        case let other?:          return other
        case nil:                 return "unknown reason"
        }
    }

    /// Settings wording for the server's `via` on a usable tier (API v68+):
    /// "via API key" or "via subscription (<cli> CLI)"; nil when the server
    /// did not say (older server, unusable tier) or sent an unknown value.
    static func describeVia(_ via: String?, provider: String) -> String? {
        switch via {
        case "key":
            return "via API key"
        case "cli":
            guard let tool = cliTool(forProvider: provider) else { return "via subscription (CLI)" }
            return "via subscription (\(tool.cliExecutable) CLI)"
        default:
            return nil
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

    /// One round trip against the server, without touching the cache: re-sync
    /// custom providers (always — the server needs them whatever its version,
    /// and the status below depends on them); then, on API v67+, push the
    /// table (skipped when the stored blob is unreadable, so the server's copy
    /// is not deleted) and fetch the per-tier status. Below v67 / unknown the
    /// answer is "nothing routes" with no routing traffic.
    ///
    /// - Parameter config: the table to push; nil = the stored one.
    /// Per-request timeout for the three refresh calls (custom-provider sync,
    /// table push, status fetch). The refresh chain is serialized, so a wedged
    /// backend on the session's 2-hour idle timeout would stall every later
    /// refresh — and the ordinary custom-provider sync rides this chain too.
    static let refreshRequestTimeout: TimeInterval = 15

    static func fetchServerState(api: LlmIdeAPIClient, serverApiVersion: Int?,
                                 config: TierRoutingConfig?) async throws -> TierRoutingServerState {
        do {
            try await CustomProvider.syncAllToBackendThrowing(api: api, timeout: refreshRequestTimeout)
        } catch {
            // Including a timeout: the routing push + status below are still
            // attempted, as when the two syncs ran independently.
            // Not fatal: the status below then reports custom tiers as the
            // server sees them, which is what routing must follow anyway.
            tierRoutingLogger.error("Custom provider sync failed: \(error.localizedDescription, privacy: .public)")
        }
        guard serverSupportsRouting(serverApiVersion) else {
            return TierRoutingServerState(apiVersion: serverApiVersion, status: nil)
        }
        var dropped: [TierRoutingDropped] = []
        let table: TierRoutingConfig?
        if let config {
            table = config
        } else if case .loaded(let stored) = TierRoutingConfig.loadOutcome() {
            table = stored
        } else {
            table = nil
            tierRoutingLogger.error("Tier routing table unreadable; not pushing it (the server keeps its copy)")
        }
        if let table { dropped = try await api.syncTierRouting(table) }
        let fetched = try await api.fetchTierRoutingStatus()
        return TierRoutingServerState(apiVersion: serverApiVersion, status: fetched.status, dropped: dropped,
                                      featureStatus: fetched.featureStatus)
    }

    /// Sign-out: the status belongs to the previous user. Also invalidates any
    /// refresh still in flight, so it cannot write the old user's state back.
    static func resetServerState() {
        TierRoutingServerCache.shared.reset()
    }
    /// The narrow set of server refusals that mean "this route's provider can't
    /// run" (never a generic failure): a routed call that hits one is retried
    /// once without the route — today's request.
    static let providerConfigErrorCodes: Set<String> = ["PROVIDER_UNAVAILABLE", "PROVIDER_NOT_AGENT_CAPABLE"]

    /// True for a server refusal of the route's provider: the buffered
    /// path's 400 (also what the legacy SSE stream maps such an `error` event
    /// to — `LlmIdeAPIClient.streamError`), or the Agent engine's stream
    /// `error` event with one of these codes.
    /// Progress phases that only report status (the agent loop's own
    /// thinking/writing lines): no tool ran, so a refused route may still be
    /// retried after them. Matches the server's rule (ai-routes.mjs).
    static func isStatusOnlyPhase(_ phase: String?) -> Bool {
        phase == "thinking" || phase == "writing"
    }

    static func isProviderConfigError(_ error: Error) -> Bool {
        if case APIError.http(let status, let code, _, _) = error {
            return status == 400 && providerConfigErrorCodes.contains(code)
        }
        if case AgentV2Error.engine(let code?, _) = error {
            return providerConfigErrorCodes.contains(code)
        }
        return false
    }
}
