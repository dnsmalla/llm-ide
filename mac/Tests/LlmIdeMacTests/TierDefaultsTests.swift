import Testing
import Foundation
@testable import LlmIdeMacLib

/// Standard is the default; chat modes are roles. Pure parts — the executable
/// copies of these assertions live in chat-contract-lab.
@Suite("Tier defaults")
struct TierDefaultsTests {
    @Test func writeThroughMapsEveryBuiltInProvider() {
        for (wire, cli) in [("anthropic", "claude_code"), ("openai", "openai"), ("google", "gemini"), ("deepseek", "deepseek")] {
            #expect(TierDefaults.writeThrough(for: TierRoute(provider: wire, model: "m"))
                        == StandardWriteThrough(activeCLI: cli, defaultModelId: "m", composerProviderId: ""))
            // Round trip: what a Standard writes reads back as the same provider.
            #expect(TierDefaults.providerWireId(forActiveCLI: cli) == wire)
        }
    }

    @Test func customStandardOnlySetsTheComposerOverride() {
        #expect(TierDefaults.writeThrough(for: TierRoute(provider: "custom:p1", model: "glm-5"))
                    == StandardWriteThrough(activeCLI: nil, defaultModelId: nil, composerProviderId: "p1"))
    }

    @Test func unwritableStandardWritesNothing() {
        #expect(TierDefaults.writeThrough(for: TierRoute(provider: "anthropic", model: "")) == nil)
        #expect(TierDefaults.writeThrough(for: TierRoute(provider: "custom", model: "llama")) == nil)
    }

    @Test func purposeAndRoleMapOneToOne() {
        #expect(ModelPurpose.allCases.map(TierDefaults.chatFeature(for:))
                    == [.chatPlanning, .chatCoding, .chatReviewing, .chatDocuments])
        #expect(TierDefaults.purpose(for: .subagents) == nil)
    }

    @Test func wireBodyStripsOnlyChatRoles() {
        let features = Dictionary(uniqueKeysWithValues: RoutedFeature.allCases.map { ($0.rawValue, "cheap") })
        let wire = TierDefaults.wireBody(TierRoutingConfig(features: features))
        #expect(Set(wire.features.keys) == Set(RoutedFeature.allCases.filter { $0.group != .chat }.map(\.rawValue)))
    }

    @Test func purposePolicyUsesATierOnlyOnItsProvider() {
        let routing = TierRoutingConfig(tiers: ["cheap": TierRoute(provider: "openai", model: "gpt-5.4-mini")],
                                        features: ["chatReviewing": "cheap"])
        let claude = TierDefaults.purposePolicy(chatProvider: "anthropic", routing: routing, legacy: [:],
                                                legacyProvider: "anthropic", defaultModelId: "claude-sonnet-5")
        #expect(claude.modelId(forMode: "review") == "claude-sonnet-5")
        let openai = TierDefaults.purposePolicy(chatProvider: "openai", routing: routing, legacy: [:],
                                                legacyProvider: "anthropic", defaultModelId: "gpt-5.5")
        #expect(openai.modelId(forMode: "review") == "gpt-5.4-mini")
    }

    private func input(activeCLI: String = "claude_code", defaultModelId: String = "claude-sonnet-5",
                       purposes: [ModelPurpose: String] = [:], composer: String = "",
                       customs: [TierCustomProviderSummary] = [],
                       routing: TierRoutingConfig = TierRoutingConfig()) -> TierMigrationInput {
        TierMigrationInput(routing: routing, activeCLI: activeCLI, defaultModelId: defaultModelId,
                           purposeModelIds: purposes, composerProviderId: composer, customProviders: customs)
    }

    @Test func allDefaultGetsStandardOnly() {
        let result = TierDefaults.migrate(input(), includePurposes: true)
        #expect(result.routing == TierRoutingConfig(tiers: ["standard": TierRoute(provider: "anthropic", model: "claude-sonnet-5")]))
    }

    @Test func morePurposesThanFreeTiersKeepsTheRestAsLegacy() {
        let result = TierDefaults.migrate(input(purposes: [.planning: "a", .coding: "b", .reviewing: "c", .documents: "d"]),
                                          includePurposes: true)
        #expect(result.routing.features == ["chatPlanning": "strong", "chatCoding": "cheap"])
        #expect(result.purposeModelIds == [.reviewing: "c", .documents: "d"])
    }

    @Test func deletedOrDisabledCustomOverrideIsIgnored() {
        let disabled = TierCustomProviderSummary(id: "p1", isEnabled: false, firstModelId: "glm-5")
        #expect(TierDefaults.migrate(input(composer: "p1", customs: [disabled]), includePurposes: true)
                    .routing.tier(.standard)?.provider == "anthropic")
        #expect(TierDefaults.migrate(input(composer: "gone"), includePurposes: true)
                    .routing.tier(.standard)?.provider == "anthropic")
    }

    @Test func emptyClaudeModelLeavesStandardUnset() {
        let result = TierDefaults.migrate(input(defaultModelId: "", purposes: [.planning: "claude-opus-5"]),
                                          includePurposes: true)
        #expect(result.routing.tier(.standard) == nil)
        #expect(result.routing.features["chatPlanning"] == "strong")
    }

    @Test func alreadyMigratedNeverTouchesPurposes() {
        let given = input(purposes: [.planning: "claude-opus-5"])
        let result = TierDefaults.migrate(given, includePurposes: false)
        #expect(result.purposeModelIds == given.purposeModelIds && result.routing.features.isEmpty)
    }
}
