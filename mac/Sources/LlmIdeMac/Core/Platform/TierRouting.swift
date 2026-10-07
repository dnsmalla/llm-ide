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
        case .loop:      return "Loop (regression replay)"
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

/// Resolves a role to a concrete provider + model, or nil for "use the
/// caller's default". Never throws and never errors: an unset or unusable tier
/// silently means today's code path (the spec's "normal use never errors
/// because of routing"); Settings shows why via `unusableReason`.
enum TierRouting {
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
    static func unusableReason(_ route: TierRoute, customProviders: [CustomProvider],
                               requiresAgentEngine: Bool = false, localCLIOnly: Bool = false) -> String? {
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
        if localCLIOnly && cliTool(forProvider: route.provider) == nil {
            return "\(builtIn.tool.displayName) has no local CLI"
        }
        // WHY: mirrors AgentV2Selection.agentCapableProviders. A non-Anthropic
        // built-in on a v2 chat would drop that turn to the classic engine,
        // breaking the per-chat engine cut.
        if requiresAgentEngine && route.provider != ClaudeCLI.provider {
            return "\(builtIn.tool.displayName) can't run on the Agent engine"
        }
        return nil
    }

    /// Pure resolver: the feature's tier route when one is set and usable.
    static func resolve(feature: RoutedFeature, config: TierRoutingConfig,
                        customProviders: [CustomProvider],
                        requiresAgentEngine: Bool = false, localCLIOnly: Bool = false) -> TierRoute? {
        guard let tier = config.tier(for: feature), let route = config.tier(tier) else { return nil }
        if let reason = unusableReason(route, customProviders: customProviders,
                                       requiresAgentEngine: requiresAgentEngine, localCLIOnly: localCLIOnly) {
            // NOTE: logged so a silent fallback to a pricier default is visible.
            tierRoutingLogger.info("Route \(feature.rawValue, privacy: .public)→\(tier.rawValue, privacy: .public) uses default: \(reason, privacy: .public)")
            return nil
        }
        return route
    }

    /// `resolve` over the persisted table and custom providers — what
    /// production callers use, at the moment they build a request.
    static func resolve(feature: RoutedFeature, requiresAgentEngine: Bool = false,
                        localCLIOnly: Bool = false) -> TierRoute? {
        resolve(feature: feature, config: .load(), customProviders: CustomProvider.loadAll(),
                requiresAgentEngine: requiresAgentEngine, localCLIOnly: localCLIOnly)
    }
}
