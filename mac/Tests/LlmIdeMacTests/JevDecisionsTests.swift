import Testing
import Foundation
@testable import LlmIdeMacLib

/// Jev is a decision API, not a chat model: it is keyed in Model Providers,
/// may back a tier for the Decisions role only, is never Standard, and is not
/// sent to a server older than API v73.
@Suite("Jev decisions")
struct JevDecisionsTests {
    private let jev = TierRoute(provider: "jev", model: "jev-latest")

    /// A v73 server reporting every tier usable, so the local checks decide.
    private static let v73 = TierRoutingServerState(
        apiVersion: 73,
        status: Dictionary(uniqueKeysWithValues: RoutingTier.allCases.map {
            ($0.rawValue, TierServerStatus(usable: true, reason: nil, agentCapable: true, agentReason: nil))
        }))

    // MARK: - Model Providers

    @Test func catalogKeysJevButNeverAsAChatOrLimitsProvider() {
        let entry = ProviderCatalog.all.first { $0.id == "jev" }
        #expect(entry?.tool == nil)
        #expect(entry?.vaultKey == "jev.apiKey")
        #expect(entry?.needsBaseURL == false)
        #expect(!ProviderCatalog.modelProviders.contains { $0.id == "jev" })
        #expect(!ProviderCatalog.limitProviders.contains { $0.id == "jev" })
        #expect(!AICliTool.selectable.contains { $0.provider == "jev" })
        #expect(!TierRouting.builtInProviders.contains { $0.wireId == "jev" },
                "builtInProviders maps to an AICliTool — the chat composer's vocabulary")
    }

    @Test func jevRowNeedsServerV73() {
        for version in [nil, 67, 72] as [Int?] {
            #expect(!ProviderCatalog.visibleRows(serverApiVersion: version).contains { $0.id == "jev" })
            #expect(ProviderCatalog.visibleRows(serverApiVersion: version).count == ProviderCatalog.all.count - 1)
        }
        for version in [73, 80] {
            #expect(ProviderCatalog.visibleRows(serverApiVersion: version).map(\.id) == ProviderCatalog.all.map(\.id))
        }
    }

    // MARK: - Roles

    @Test func decisionsIsAServerRole() {
        #expect(RoutedFeature.decisions.rawValue == "decisions")
        #expect(RoutedFeature.decisions.group == .server)
        #expect(RoutedFeature.decisions.displayName == "Decisions")
        #expect(RoutedFeature.decisions.unsetLabel == "Built-in default")
        #expect(RoutedFeature.decisions.explanation?.contains("`decide`") == true)
        #expect(RoutedFeature.decisions.requiredServerApiVersion == 73)
        #expect(RoutedFeature.pipeline.requiredServerApiVersion == nil)
    }

    @Test func jevTierServesOnlyTheDecisionsRole() {
        #expect(TierRouting.unusableReason(jev, customProviders: [], forDecisions: true) == nil)
        let reason = TierRouting.unusableReason(jev, customProviders: [])
        #expect(reason == "Jev only answers decisions — use it for the Decisions role")
        #expect(TierRouting.unusableReason(jev, customProviders: [], localCLIOnly: true) == reason)
        #expect(TierRouting.unusableReason(jev, customProviders: [], requiresAgentEngine: true) == reason)
        // An LLM tier still serves Decisions.
        #expect(TierRouting.unusableReason(TierRoute(provider: "anthropic", model: "claude-haiku-4-5"),
                                           customProviders: [], forDecisions: true) == nil)
    }

    @Test func resolverRoutesJevForDecisionsOnly() {
        for feature in RoutedFeature.allCases {
            let table = TierRoutingConfig(tiers: ["cheap": jev], features: [feature.rawValue: "cheap"])
            let resolved = TierRouting.resolve(feature: feature, config: table, customProviders: [],
                                               server: Self.v73, localCLIOnly: feature == .autoTasks)
            #expect(resolved == (feature == .decisions ? jev : nil), "\(feature.rawValue)")
        }
    }

    @Test func serverDecisionOnlyReasonIsReadable() {
        var server = Self.v73
        server.featureStatus = ["pipeline": TierFeatureServerStatus(usable: false, reason: "decision_only")]
        #expect(TierRouting.serverFeatureUnusableReason(.pipeline, server: server)
                    == "Jev only answers decisions — use it for the Decisions role")
        #expect(TierRouting.describeServerReason("decision_only") == TierRouting.decisionOnlyNote)
    }

    // MARK: - Standard

    @Test func standardIsNeverJev() {
        #expect(!TierDefaults.canBeStandard(provider: "jev"))
        #expect(TierDefaults.canBeStandard(provider: "anthropic"))
        #expect(TierDefaults.writeThrough(for: jev) == nil, "never written into activeCLI / the composer")
        #expect(TierDefaults.cliRawValue(forProvider: "jev") == nil)
    }

    // MARK: - Version gate

    @Test func wireBodyDropsDecisionsAndJevBelowV73() {
        let table = TierRoutingConfig(tiers: ["cheap": jev, "strong": TierRoute(provider: "anthropic", model: "m")],
                                      features: ["decisions": "cheap", "pipeline": "strong", "chatCoding": "strong"])
        for version in [nil, 67, 72] as [Int?] {
            let wire = TierDefaults.wireBody(table, serverApiVersion: version)
            #expect(wire.tiers.keys.sorted() == ["strong"], "v\(String(describing: version))")
            #expect(wire.features == ["pipeline": "strong"], "v\(String(describing: version))")
        }
        for version in [73, 80] {
            let wire = TierDefaults.wireBody(table, serverApiVersion: version)
            #expect(wire.tiers == table.tiers)
            #expect(wire.features == ["decisions": "cheap", "pipeline": "strong"])
        }
        #expect(!TierRouting.serverSupportsDecisions(nil) && !TierRouting.serverSupportsDecisions(72))
        #expect(TierRouting.serverSupportsDecisions(73))
    }

    // MARK: - Chat tool display

    @Test func decideToolHasAVerbAndIcon() {
        for name in ["decide", "mcp__llmide__decide"] {
            #expect(ClaudeToolPresentation.verb(name) == "Deciding")
            #expect(ClaudeToolPresentation.icon(for: name) == "scale.3d")
        }
        #expect(ClaudeToolPresentation.progressLabel(phase: "tool", tool: "decide") == "Deciding…")
    }
}
