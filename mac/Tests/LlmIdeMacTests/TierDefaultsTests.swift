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
}
