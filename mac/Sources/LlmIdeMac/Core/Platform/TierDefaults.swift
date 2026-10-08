import Foundation

/// What saving the Standard tier writes into the legacy default fields.
///
/// `activeCLI` / `defaultModelId` stay the internal representation (~20
/// readers: Loop, Auto Tasks, quick chat, the phone bridge, the composer), so
/// Standard drives them instead of replacing them.
public struct StandardWriteThrough: Sendable, Equatable {
    /// New `AppConfig.activeCLI`, or nil to leave it (a custom Standard —
    /// `activeCLI` is an `AICliTool` raw value and cannot hold `custom:<id>`).
    public let activeCLI: String?
    /// New `AppConfig.defaultModelId`, or nil to leave it.
    public let defaultModelId: String?
    /// New composer provider override (`codeAssistProvider`): the custom
    /// provider's id, or "" so a built-in Standard is what new chats use.
    public let composerProviderId: String

    public init(activeCLI: String?, defaultModelId: String?, composerProviderId: String) {
        self.activeCLI = activeCLI
        self.defaultModelId = defaultModelId
        self.composerProviderId = composerProviderId
    }
}

/// A custom provider as the migration sees it — the public projection of the
/// internal `CustomProvider`, so `chat-contract-lab` can build inputs.
public struct TierCustomProviderSummary: Sendable, Equatable {
    public let id: String
    public let isEnabled: Bool
    public let firstModelId: String?
    /// Display name, for Settings wording only ("" reads as the id).
    public let name: String
    /// Every model id, in order (nil at init = just `firstModelId`): the
    /// composer starts on Standard's model only when the provider lists it.
    public let modelIds: [String]

    public init(id: String, isEnabled: Bool, firstModelId: String?, name: String = "", modelIds: [String]? = nil) {
        self.id = id
        self.isEnabled = isEnabled
        self.firstModelId = firstModelId
        self.name = name
        self.modelIds = modelIds ?? firstModelId.map { [$0] } ?? []
    }
}

/// Everything the migration reads, as values.
public struct TierMigrationInput: Sendable, Equatable {
    public var routing: TierRoutingConfig
    public var activeCLI: String
    public var defaultModelId: String
    public var purposeModelIds: [ModelPurpose: String]
    /// `codeAssistProvider`: a custom provider id, or "".
    public var composerProviderId: String
    public var customProviders: [TierCustomProviderSummary]

    public init(routing: TierRoutingConfig, activeCLI: String, defaultModelId: String,
                purposeModelIds: [ModelPurpose: String], composerProviderId: String,
                customProviders: [TierCustomProviderSummary]) {
        self.routing = routing
        self.activeCLI = activeCLI
        self.defaultModelId = defaultModelId
        self.purposeModelIds = purposeModelIds
        self.composerProviderId = composerProviderId
        self.customProviders = customProviders
    }
}

/// What the migration decided.
public struct TierMigrationResult: Sendable, Equatable {
    public var routing: TierRoutingConfig
    /// Purpose ids still honoured as legacy values (no tier was free for
    /// them); empty and migrated entries are removed.
    public var purposeModelIds: [ModelPurpose: String]
}

/// The Standard tier is the default, and the chat modes are roles.
///
/// Pure functions over value inputs only — no UserDefaults, no `AppConfig` —
/// so `chat-contract-lab` asserts them (this toolchain has no XCTest).
/// `AppConfig+TierDefaults.swift` applies them.
public enum TierDefaults {
    /// Set once the one-time purpose-model migration has run.
    public static let migratedFlagKey = "tierDefaultMigrated"
    /// The composer's custom-provider override. Lives in Core (not
    /// `Features/Chat`) because Standard's write-through sets it.
    public static let composerProviderKey = "codeAssistProvider"

    /// The chat role that chooses `purpose`'s tier.
    public static func chatFeature(for purpose: ModelPurpose) -> RoutedFeature {
        switch purpose {
        case .planning:  return .chatPlanning
        case .coding:    return .chatCoding
        case .reviewing: return .chatReviewing
        case .documents: return .chatDocuments
        }
    }

    /// The purpose a chat role stands for, or nil for any other role.
    public static func purpose(for feature: RoutedFeature) -> ModelPurpose? {
        ModelPurpose.allCases.first { chatFeature(for: $0) == feature }
    }

    /// The `AICliTool` raw value that runs a built-in tier provider
    /// (anthropic→claude_code, openai→openai, google→gemini,
    /// deepseek→deepseek, custom→custom — the shared OpenAI-compatible
    /// endpoint), or nil for a named custom (`custom:<id>`) or unknown provider.
    public static func cliRawValue(forProvider provider: String) -> String? {
        TierRouting.builtInProviders.first { $0.wireId == provider }?.tool.rawValue
    }

    /// The wire provider an `activeCLI` value means. Empty or unknown reads as
    /// Claude, as every `AppConfig` reader already does.
    public static func providerWireId(forActiveCLI activeCLI: String) -> String {
        (AICliTool(rawValue: activeCLI) ?? .claudeCode).provider
    }

    /// What saving `standard` writes, or nil when it cannot be written (no
    /// model; a provider that is neither built-in nor `custom:<id>`).
    public static func writeThrough(for standard: TierRoute) -> StandardWriteThrough? {
        let model = standard.model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return nil }
        if let customId = TierRouting.customProviderId(standard.provider) {
            return StandardWriteThrough(activeCLI: nil, defaultModelId: nil, composerProviderId: customId)
        }
        guard let cli = cliRawValue(forProvider: standard.provider) else { return nil }
        return StandardWriteThrough(activeCLI: cli, defaultModelId: model, composerProviderId: "")
    }

    /// Whether a tier provider never reaches the server: the shared Custom
    /// endpoint (wire id exactly `custom`), which the server's provider check
    /// rejects. It runs as Standard (`activeCLI` = `custom`) and in chat modes;
    /// server roles on its tier keep their built-in default.
    public static func isMacOnlyProvider(_ provider: String) -> Bool {
        provider == AICliTool.custom.provider
    }

    /// The table as `POST /kb/routing-tiers` receives it: chat roles removed
    /// (Mac-only — the server would drop them as `unknown_feature`), and tiers
    /// on a Mac-only provider removed (the server would drop them as
    /// `invalid_provider`; a server role on that tier then finds it unset and
    /// keeps its built-in default). Unknown keys from a newer build are kept,
    /// as before, so the server reports them.
    public static func wireBody(_ config: TierRoutingConfig) -> TierRoutingConfig {
        var body = config
        body.tiers = config.tiers.filter { _, route in !isMacOnlyProvider(route.provider) }
        body.features = config.features.filter { key, _ in RoutedFeature(rawValue: key)?.group != .chat }
        return body
    }

    /// The tier `feature` resolves through: its own when set; for an unset
    /// Background role (Loop, Auto Tasks, Quick chat), Standard when Standard
    /// is a named custom provider — the one Standard `activeCLI` cannot hold,
    /// so without this those roles would run the previous built-in default.
    /// Any other unset role is nil: Mac roles then read `activeCLI` /
    /// `defaultModelId`, which Standard's write-through keeps equal to a
    /// built-in Standard (including each chat mode's model for quick chat),
    /// and server roles keep the server's built-in default. The resolver still
    /// applies every usability check to the tier returned.
    public static func effectiveTier(for feature: RoutedFeature, routing: TierRoutingConfig) -> RoutingTier? {
        if let tier = routing.tier(for: feature) { return tier }
        guard feature.group == .background, let standard = routing.tier(.standard),
              TierRouting.customProviderId(standard.provider) != nil else { return nil }
        return .standard
    }

    /// The model the composer starts on for custom provider `customProviderId`:
    /// Standard's model when Standard IS that provider and it still lists the
    /// model, else the provider's first model ("" when it has none).
    public static func composerStartModel(customProviderId: String, modelIds: [String], standard: TierRoute?) -> String {
        if let standard, standard.provider == "custom:\(customProviderId)", modelIds.contains(standard.model) {
            return standard.model
        }
        return modelIds.first ?? ""
    }

    /// The chat-mode model policy for a chat on `chatProvider`.
    ///
    /// Per purpose: when its chat role names a tier, that tier's model — but
    /// only if the tier's provider IS the chat's provider (a chat's provider is
    /// fixed per chat; a mode only swaps the model). A set role decides even
    /// when it does not apply here, so a replaced legacy value never returns.
    /// When the role is unset, a leftover legacy purpose model (one the
    /// migration had no free tier for) applies on the provider it was picked
    /// for. Otherwise the default.
    ///
    /// - Parameters:
    ///   - chatProvider: the chat's wire provider (`anthropic`, `openai`, …, `custom:<id>`).
    ///   - legacy: `AppConfig.purposeModelIds` left by the migration.
    ///   - legacyProvider: the wire provider those ids belong to (`activeCLI`'s).
    ///   - defaultModelId: the model when no purpose applies.
    public static func purposePolicy(chatProvider: String, routing: TierRoutingConfig,
                                     legacy: [ModelPurpose: String], legacyProvider: String,
                                     defaultModelId: String) -> PurposeModelPolicy {
        var perPurpose: [ModelPurpose: String] = [:]
        for purpose in ModelPurpose.allCases {
            if let tier = routing.tier(for: chatFeature(for: purpose)) {
                if let route = routing.tier(tier), route.provider == chatProvider {
                    perPurpose[purpose] = route.model
                }
            } else if chatProvider == legacyProvider, let id = legacy[purpose] {
                perPurpose[purpose] = id
            }
        }
        return PurposeModelPolicy(perPurpose: perPurpose, defaultModelId: defaultModelId)
    }

    /// Standard as it effectively is today, or nil when no tier can name it.
    ///
    /// An enabled custom composer override wins (new chats run on it); one
    /// with no model yields nil — a built-in Standard would have to clear the
    /// override and move chats. Otherwise (`activeCLI`'s provider,
    /// `defaultModelId`), but only when writing it back yields the same
    /// `activeCLI` (GLM and Copilot cannot; the shared Custom endpoint can) and
    /// a model is known (Claude's live list may not be loaded — never store "").
    public static func standardFromLegacy(activeCLI: String, defaultModelId: String, composerProviderId: String,
                                          customProviders: [TierCustomProviderSummary]) -> TierRoute? {
        if !composerProviderId.isEmpty,
           let custom = customProviders.first(where: { $0.id == composerProviderId && $0.isEnabled }) {
            let first = custom.firstModelId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return first.isEmpty ? nil : TierRoute(provider: "custom:\(custom.id)", model: first)
        }
        let model = defaultModelId.trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = providerWireId(forActiveCLI: activeCLI)
        guard !model.isEmpty, cliRawValue(forProvider: provider) == activeCLI else { return nil }
        return TierRoute(provider: provider, model: model)
    }

    /// The launch migration.
    ///
    /// Rule 1 (every launch while Standard is unset): fill it from
    /// `standardFromLegacy`. Rule 2 (once, `includePurposes`): each non-empty
    /// purpose model M — on `activeCLI`'s provider P, the provider it was picked
    /// for — gets its chat role pointed at a tier equal to (P, M), else at the
    /// first free of Strong, Cheap; with no free tier it stays a legacy value.
    /// A role already set is left alone. Pure: the caller saves.
    public static func migrate(_ input: TierMigrationInput, includePurposes: Bool) -> TierMigrationResult {
        var routing = input.routing
        if routing.tier(.standard) == nil,
           let standard = standardFromLegacy(activeCLI: input.activeCLI, defaultModelId: input.defaultModelId,
                                             composerProviderId: input.composerProviderId,
                                             customProviders: input.customProviders) {
            routing.tiers[RoutingTier.standard.rawValue] = standard
        }
        guard includePurposes else {
            return TierMigrationResult(routing: routing, purposeModelIds: input.purposeModelIds)
        }
        let provider = providerWireId(forActiveCLI: input.activeCLI)
        // GLM / Copilot are not tier providers: their ids stay legacy.
        let isTierProvider = cliRawValue(forProvider: provider) == input.activeCLI
        var remaining: [ModelPurpose: String] = [:]
        for purpose in ModelPurpose.allCases {
            let model = (input.purposeModelIds[purpose] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !model.isEmpty else { continue }
            let feature = chatFeature(for: purpose)
            guard isTierProvider, routing.tier(for: feature) == nil,
                  let tier = tierHolding(TierRoute(provider: provider, model: model), in: &routing) else {
                remaining[purpose] = model
                continue
            }
            routing.features[feature.rawValue] = tier.rawValue
        }
        return TierMigrationResult(routing: routing, purposeModelIds: remaining)
    }

    /// A tier already equal to `route`, else the first free of Strong, Cheap
    /// (filled with `route`), else nil. Standard is never taken. A tier is
    /// free only when it is unset AND no role points at it — filling an empty
    /// tier a role already names would change what that role runs.
    private static func tierHolding(_ route: TierRoute, in routing: inout TierRoutingConfig) -> RoutingTier? {
        if let same = RoutingTier.allCases.first(where: { routing.tier($0) == route }) { return same }
        let referenced = Set(routing.features.values)
        guard let free = [RoutingTier.strong, .cheap].first(where: {
            routing.tier($0) == nil && !referenced.contains($0.rawValue)
        }) else { return nil }
        routing.tiers[free.rawValue] = route
        return free
    }

    // MARK: - Settings wording (pure, so the lab asserts it)

    /// What new chats run on right now: "Claude · claude-opus-5", or
    /// "· account default" when no model is set.
    ///
    /// Mirrors the composer (`CodeAssistantModelState.applyComposerProvider`):
    /// an override naming an existing, enabled custom provider wins, on the
    /// model a new chat starts on there (`composerStartModel`: Standard's when
    /// Standard is that provider, else its first); a dead or disabled override
    /// is ignored and the built-in default applies. Pass `composerProviderId:
    /// ""` for the Mac roles, which never read the override.
    public static func describeCurrentDefault(activeCLI: String, defaultModelId: String,
                                              composerProviderId: String,
                                              customProviders: [TierCustomProviderSummary],
                                              standard: TierRoute? = nil) -> String {
        if !composerProviderId.isEmpty,
           let custom = customProviders.first(where: { $0.id == composerProviderId && $0.isEnabled }) {
            let name = custom.name.isEmpty ? custom.id : custom.name
            let start = composerStartModel(customProviderId: custom.id, modelIds: custom.modelIds, standard: standard)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(name) · \(start.isEmpty ? "no model" : start)"
        }
        let tool = AICliTool(rawValue: activeCLI) ?? .claudeCode
        let model = defaultModelId.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(tool.displayName) · \(model.isEmpty ? "account default" : model)"
    }

    /// Whether `standard` is what new chats already run (a Standard set
    /// before this update was never written through). A custom Standard is
    /// applied through the composer override, and only when the composer
    /// starts on Standard's model — i.e. the provider still lists it.
    public static func isApplied(_ standard: TierRoute, activeCLI: String, defaultModelId: String,
                                 composerProviderId: String,
                                 customProviders: [TierCustomProviderSummary]) -> Bool {
        guard let write = writeThrough(for: standard) else { return false }
        if let customId = TierRouting.customProviderId(standard.provider) {
            guard write.composerProviderId == composerProviderId,
                  let custom = customProviders.first(where: { $0.id == customId && $0.isEnabled }) else { return false }
            return composerStartModel(customProviderId: customId, modelIds: custom.modelIds, standard: standard)
                == standard.model
        }
        return write.activeCLI == activeCLI
            && write.defaultModelId == defaultModelId
            && write.composerProviderId == composerProviderId
    }

    /// The warning on the Standard row, or nil. Runtime never errors: an unset
    /// or unusable Standard keeps the last written default.
    public static func standardWarning(isSet: Bool, unusableReason: String?, currentDefault: String) -> String? {
        guard isSet else {
            return "Standard isn't set — new chats and roles on Standard keep using \(currentDefault) until you choose one."
        }
        guard let unusableReason else { return nil }
        return "Standard can't be used — \(unusableReason). New chats keep using \(currentDefault), the last default."
    }

    /// Shown under a Standard the Agent (v2) engine cannot run.
    public static let standardAgentEngineNote =
        "Agent-engine chats need Claude or a custom provider with an Anthropic-compatible URL — "
        + "with this Standard, new chats use the classic engine."

    /// Why a role or tier on the shared Custom endpoint is not routed.
    public static let macOnlyProviderNote =
        "the shared Custom endpoint runs only on this Mac — as Standard or in chat modes, never for server roles"

    /// A purpose model the migration had no free tier for.
    public static func legacyNote(purpose: ModelPurpose, model: String) -> String {
        "\(purpose.rawValue.capitalized): kept old model \(model) — choose a tier to replace it"
    }

    /// A chat role only swaps the model of chats already on its tier's provider.
    public static func chatRoleProviderNote(providerName: String) -> String {
        "used only in chats on \(providerName)"
    }

    /// Which chat modes a purpose's role covers (moved from the removed
    /// PurposeModelPickers).
    public static func modesHelp(_ purpose: ModelPurpose) -> String {
        switch purpose {
        case .planning:  return "Used by Plan and Assist Plan"
        case .coding:    return "Used by Execute and Auto"
        case .reviewing: return "Used by Code Review"
        case .documents: return "Used by Document and Ask"
        }
    }
}
