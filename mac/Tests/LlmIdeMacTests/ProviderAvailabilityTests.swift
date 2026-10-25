import Testing
import Foundation
@testable import LlmIdeMacLib

/// Which tier providers can run: the pure availability table, the picker /
/// quick-chat helpers, and `TierDefaults.reconcile`.
@Suite("Provider availability")
struct ProviderAvailabilityTests {
    private func custom(_ id: String, enabled: Bool = true, key: String = "k.apiKey") -> AvailabilityCustomProvider {
        AvailabilityCustomProvider(wireId: "custom:\(id)", isEnabled: enabled, apiKeyName: key)
    }

    private func available(keys: Set<String> = [], clis: Set<AICliTool> = [],
                           customs: [AvailabilityCustomProvider] = []) -> Set<String> {
        ProviderAvailability.availableProviders(storedKeys: keys, installedCLIs: clis, customProviders: customs)
    }

    @Test func nothingStoredMeansNothingAvailable() {
        #expect(available().isEmpty)
    }

    @Test func claudeNeedsItsCLIOrItsKey() {
        #expect(available(clis: [.claudeCode]) == ["anthropic"])
        #expect(available(keys: [ClaudeCLI.vaultKey]) == ["anthropic"])
        #expect(available(clis: [.openai, .gemini]).contains("anthropic") == false)
    }

    @Test func openAIAndGoogleTakeAKeyOrTheirCLI() {
        #expect(available(keys: ["openai.apiKey"]) == ["openai"])
        #expect(available(clis: [.openai]) == ["openai"], "CLI-only OpenAI")
        #expect(available(keys: ["google.apiKey"]) == ["google"])
        #expect(available(clis: [.gemini]) == ["google"])
    }

    @Test func deepSeekNeedsItsKeyAndHasNoCLIMode() {
        #expect(available(keys: ["deepseek.apiKey"]) == ["deepseek"])
        #expect(available(clis: [.claudeCode, .openai, .gemini]).contains("deepseek") == false)
    }

    @Test func sharedCustomEndpointNeedsItsKey() {
        #expect(available(keys: ["custom.apiKey"]) == ["custom"])
        #expect(available(keys: ["custom.baseUrl"]).isEmpty, "a base URL alone is not a key")
    }

    @Test func namedCustomProviderNeedsItsKeyAndNothingElse() {
        #expect(available(keys: ["k.apiKey"], customs: [custom("a")]) == ["custom:a"])
        #expect(available(customs: [custom("a")]).isEmpty, "no key stored")
        #expect(available(keys: ["other.apiKey"], customs: [custom("a")]).isEmpty)
    }

    @Test func disabledCustomProviderIsNeverAvailable() {
        #expect(available(keys: ["k.apiKey"], customs: [custom("a", enabled: false)]).isEmpty)
    }

    @Test func unknownAvailabilityHidesNothing() {
        for provider in ["anthropic", "openai", "google", "deepseek", "custom", "custom:x", "jev"] {
            #expect(ProviderAvailability.isListed(provider, available: nil))
        }
        #expect(ProviderAvailability.nothingAvailable(nil) == false)
        #expect(ProviderAvailability.noProviderMessage(standard: nil, available: nil) == nil)
        #expect(ProviderAvailability.noProviderMessage(
            standard: TierRoute(provider: "deepseek", model: "m"), available: nil) == nil)
    }

    @Test func knownAvailabilityListsOnlyAvailableAndNeverJudgesJev() {
        let known: Set<String> = ["anthropic"]
        #expect(ProviderAvailability.isListed("anthropic", available: known))
        #expect(!ProviderAvailability.isListed("deepseek", available: known))
        #expect(!ProviderAvailability.isListed("custom:gone", available: known))
        #expect(ProviderAvailability.isListed(TierRouting.decisionOnlyProvider, available: known))
        #expect(ProviderAvailability.nothingAvailable([]))
        #expect(!ProviderAvailability.nothingAvailable(known))
    }

    @Test func quickChatRefusesOnlyWhenKnownAndStandardCannotRun() {
        let sonnet = TierRoute(provider: "anthropic", model: "claude-sonnet")
        let deepseek = TierRoute(provider: "deepseek", model: "m")
        #expect(ProviderAvailability.noProviderMessage(standard: sonnet, available: ["anthropic"]) == nil)
        #expect(ProviderAvailability.noProviderMessage(standard: deepseek, available: ["anthropic"])
                    == ProviderAvailability.noProviderText)
        #expect(ProviderAvailability.noProviderMessage(standard: nil, available: ["anthropic"])
                    == ProviderAvailability.noProviderText)
    }

    @Test func quickChatDoesNotRefuseWhenTheServerOrAResolvedRouteCanRun() {
        let deepseek = TierRoute(provider: "deepseek", model: "m")
        #expect(ProviderAvailability.noProviderMessage(standard: deepseek, available: [], serverUsable: true) == nil)
        #expect(ProviderAvailability.noProviderMessage(standard: deepseek, available: [], routeResolves: true) == nil)
        #expect(ProviderAvailability.noProviderMessage(standard: nil, available: [], serverUsable: true) == nil)
        #expect(ProviderAvailability.noProviderMessage(standard: deepseek, available: []) != nil)
    }

    // MARK: - reconcile

    private func models(_ provider: String) -> [AIModel] {
        switch provider {
        case "anthropic":
            return [AIModel(id: "claude-haiku-9", displayName: "Haiku"),
                    AIModel(id: "claude-opus-9", displayName: "Opus"),
                    AIModel(id: "claude-sonnet-9", displayName: "Sonnet")]
        case "openai":   return [AIModel(id: "gpt-x", displayName: "GPT X")]
        case "deepseek": return [AIModel(id: "ds-1", displayName: "DS")]
        case "custom:a": return [AIModel(id: "relay-1", displayName: "Relay")]
        default:         return []
        }
    }

    private func reconcile(_ routing: TierRoutingConfig, available: Set<String>,
                           customs: [String] = [],
                           models: ((String) -> [AIModel])? = nil) -> TierReconcileResult {
        TierDefaults.reconcile(routing, available: available, customProviderIds: customs,
                               models: models ?? self.models)
    }

    private func table(_ tiers: [RoutingTier: TierRoute]) -> TierRoutingConfig {
        TierRoutingConfig(tiers: Dictionary(uniqueKeysWithValues: tiers.map { ($0.key.rawValue, $0.value) }))
    }

    @Test func deepSeekStandardWithoutAKeyBecomesClaudeSonnet() {
        let input = table([.standard: TierRoute(provider: "deepseek", model: "ds-1")])
        let result = reconcile(input, available: ["anthropic"])
        #expect(result.routing.tier(.standard) == TierRoute(provider: "anthropic", model: "claude-sonnet-9"))
        #expect(result.standardChanged)
    }

    @Test func nothingAvailableLeavesEveryTierEmpty() {
        let input = table([.standard: TierRoute(provider: "deepseek", model: "ds-1"),
                           .strong: TierRoute(provider: "openai", model: "gpt-x")])
        let result = reconcile(input, available: [])
        #expect(result.routing.tiers.isEmpty)
        #expect(result.standardChanged)
    }

    @Test func claudeListNotLoadedKeepsTheRouteAndDefers() {
        let input = table([.standard: TierRoute(provider: "deepseek", model: "ds-1")])
        let result = reconcile(input, available: ["anthropic"], models: { _ in [] })
        #expect(result.routing == input, "never cleared without a replacement")
        #expect(result.deferred)
        #expect(!result.standardChanged)
    }

    @Test func nothingAvailableStillClearsToEmpty() {
        let input = table([.standard: TierRoute(provider: "deepseek", model: "ds-1")])
        let result = reconcile(input, available: [], models: { _ in [] })
        #expect(result.routing.tiers.isEmpty)
        #expect(!result.deferred)
    }

    @Test func serverUsableTierIsNeverCleared() {
        let input = table([.standard: TierRoute(provider: "deepseek", model: "ds-1"),
                           .strong: TierRoute(provider: "openai", model: "gpt-x")])
        let result = TierDefaults.reconcile(input, available: ["anthropic"], customProviderIds: [],
                                            serverUsable: [.standard], models: models)
        #expect(result.routing.tier(.standard) == input.tier(.standard), "server runs it via an env key")
        #expect(result.routing.tier(.strong) == TierRoute(provider: "anthropic", model: "claude-opus-9"))
        #expect(!result.standardChanged)
    }

    @Test func unsetStrongStaysUnsetAndEmptyStandardIsFilled() {
        let result = reconcile(TierRoutingConfig(), available: ["anthropic"])
        #expect(result.routing.tier(.standard)?.provider == "anthropic")
        #expect(result.routing.tier(.strong) == nil)
        #expect(result.routing.tier(.cheap) == nil)
        #expect(result.routing.tier(.image) == nil)
    }

    @Test func clearedStrongAndCheapRefillByFamilyFromStandardsProvider() {
        let input = table([.standard: TierRoute(provider: "anthropic", model: "claude-sonnet-9"),
                           .strong: TierRoute(provider: "deepseek", model: "ds-1"),
                           .cheap: TierRoute(provider: "openai", model: "gpt-x")])
        let result = reconcile(input, available: ["anthropic"])
        #expect(result.routing.tier(.strong) == TierRoute(provider: "anthropic", model: "claude-opus-9"))
        #expect(result.routing.tier(.cheap) == TierRoute(provider: "anthropic", model: "claude-haiku-9"))
        #expect(!result.standardChanged)
    }

    @Test func availableRoutesAreUntouched() {
        let input = table([.standard: TierRoute(provider: "openai", model: "gpt-x"),
                           .strong: TierRoute(provider: "anthropic", model: "claude-opus-9")])
        let result = reconcile(input, available: ["openai", "anthropic"])
        #expect(result.routing == input)
        #expect(!result.standardChanged)
    }

    @Test func jevAndUnjudgedProvidersAreLeftAlone() {
        let jev = TierRoute(provider: TierRouting.decisionOnlyProvider, model: "jev-fast")
        let future = TierRoute(provider: "someday", model: "m")
        let input = table([.standard: TierRoute(provider: "anthropic", model: "claude-sonnet-9"),
                           .strong: jev, .cheap: future])
        let result = reconcile(input, available: ["anthropic"])
        #expect(result.routing.tier(.strong) == jev)
        #expect(result.routing.tier(.cheap) == future)
    }

    @Test func fallsBackThroughBuiltInsThenCustom() {
        let ds = reconcile(table([.standard: TierRoute(provider: "openai", model: "gpt-x")]),
                           available: ["deepseek"])
        #expect(ds.routing.tier(.standard) == TierRoute(provider: "deepseek", model: "ds-1"))
        let relay = reconcile(table([.standard: TierRoute(provider: "openai", model: "gpt-x")]),
                              available: ["custom:a"], customs: ["custom:b", "custom:a"])
        #expect(relay.routing.tier(.standard) == TierRoute(provider: "custom:a", model: "relay-1"))
    }

    @Test func deletedCustomProviderIsClearedAndRefilled() {
        let input = table([.standard: TierRoute(provider: "custom:gone", model: "x")])
        let result = reconcile(input, available: ["openai"])
        #expect(result.routing.tier(.standard) == TierRoute(provider: "openai", model: "gpt-x"))
    }

    @Test func imageTierOnlyRefillsFromImageProviders() {
        let input = table([.standard: TierRoute(provider: "anthropic", model: "claude-sonnet-9"),
                           .image: TierRoute(provider: "openai", model: "gpt-image-1")])
        // OpenAI gone, only Claude + DeepSeek left: no image provider to take
        // its place, so the route is left as it is (never cleared unreplaced).
        let none = reconcile(input, available: ["anthropic", "deepseek"])
        #expect(none.routing.tier(.image) == input.tier(.image))
        #expect(!none.deferred)
        // Google available: refilled from Google's image models.
        let google = reconcile(input, available: ["anthropic", "google"])
        #expect(google.routing.tier(.image)?.provider == "google")
        #expect(ImageTierRouting.modelIds(forProvider: "google").contains(google.routing.tier(.image)?.model ?? ""))
    }
}
