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
    /// deepseek→deepseek), or nil for a custom or unknown provider.
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

    /// The table as `POST /kb/routing-tiers` receives it: chat roles removed
    /// (Mac-only — the server would drop them as `unknown_feature`). Unknown
    /// keys from a newer build are kept, as before, so the server reports them.
    public static func wireBody(_ config: TierRoutingConfig) -> TierRoutingConfig {
        var body = config
        body.features = config.features.filter { key, _ in RoutedFeature(rawValue: key)?.group != .chat }
        return body
    }
}
