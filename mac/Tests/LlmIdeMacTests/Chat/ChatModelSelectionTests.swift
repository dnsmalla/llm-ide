import Testing
import Foundation
@testable import LlmIdeMacLib

/// Regressions from the 2026-09 chat review (F5, model / provider selection).
@MainActor
@Suite("Chat model selection")
struct ChatModelSelectionTests {
    private let known: Set<String> = Set(AICliTool.selectable.flatMap { $0.models.map(\.id) })

    @Test("A live-fetched model survives a relaunch under its non-Claude provider")
    func liveModelSurvivesRelaunch() {
        // Regression: ids only the provider's live list knows were reset to
        // the CLAUDE default while the provider stayed OpenAI, so every turn
        // (and the phone proxy) sent a Claude model to OpenAI.
        #expect(AppConfig.startupModelId(stored: "gpt-5.9-live", activeCLI: "openai",
                                         knownModelIds: known) == "gpt-5.9-live")
    }

    @Test("An unusable stored id falls back to the ACTIVE provider's default")
    func fallbackFollowsProvider() {
        let openaiDefault = AICliTool.openai.defaultModelId
        // A Claude id under OpenAI can't run there.
        #expect(AppConfig.startupModelId(stored: "claude-weird", activeCLI: "openai",
                                         knownModelIds: known) == openaiDefault)
        #expect(AppConfig.startupModelId(stored: nil, activeCLI: "openai",
                                         knownModelIds: known) == openaiDefault)
        // Even a RECOGNISED Claude id can't run under OpenAI (review: the
        // known-ids check used to come first and kept it).
        if let knownClaude = AICliTool.claudeCode.models.first?.id {
            #expect(AppConfig.startupModelId(stored: knownClaude, activeCLI: "openai",
                                             knownModelIds: known) == openaiDefault)
            // …but the generic Custom tool may front an Anthropic-compatible relay.
            #expect(AppConfig.startupModelId(stored: knownClaude, activeCLI: "custom",
                                             knownModelIds: known) == knownClaude)
        }
        // Claude keeps its stricter rule — judged against the account's live
        // list: an id it does not carry resets to the live default…
        let live = [AIModel(id: "claude-sonnet-5", displayName: "Sonnet 5")]
        #expect(AppConfig.startupModelId(stored: "claude-not-a-model", activeCLI: "claude_code",
                                         knownModelIds: known, liveClaudeModels: live) == "claude-sonnet-5")
        // …while with no live list yet there is nothing to judge it by.
        #expect(AppConfig.startupModelId(stored: "claude-not-a-model", activeCLI: "claude_code",
                                         knownModelIds: known, liveClaudeModels: []) == "claude-not-a-model")
    }

    @Test("Known and retired ids behave as before")
    func knownAndRetired() throws {
        let someKnown = try #require(known.first)
        #expect(AppConfig.startupModelId(stored: someKnown, activeCLI: "claude_code",
                                         knownModelIds: known) == someKnown)
        if let (old, new) = AppConfig.retiredModelIds.first {
            #expect(AppConfig.startupModelId(stored: old, activeCLI: "claude_code",
                                             knownModelIds: known) == new)
        }
    }

    @Test("A Settings provider change moves the composer's provider, not just its model")
    func followsDefaultProvider() {
        let state = CodeAssistantModelState()
        state.selectedProvider = ClaudeCLI.provider
        state.selectedModel = AICliTool.claudeCode.defaultModelId
        state.followDefaultProvider(activeCLI: "openai", defaultModelId: AICliTool.openai.defaultModelId)
        #expect(state.selectedProvider == "openai")
        #expect(state.selectedModel == AICliTool.openai.defaultModelId)
    }

    private func provider(_ id: String, models: [String], enabled: Bool = true) -> CustomProvider {
        var p = CustomProvider(name: id, baseURL: "https://example.invalid/v1", apiKey: "custom.\(id).apiKey",
                               models: models.map { AIModel(id: $0, displayName: $0) })
        p.id = id
        p.isEnabled = enabled
        return p
    }

    @Test("A deleted or disabled custom provider stops being sent")
    func deadCustomProviderFallsBack() {
        let state = CodeAssistantModelState()
        state.selectedProvider = "custom:glm"
        state.selectedModel = "glm-5"
        state.customProviders = []                                     // deleted
        state.reconcileCustomSelection(activeCLI: "claude_code", defaultModelId: "claude-x")
        #expect(state.selectedProvider == "claude_code" && state.selectedModel == "claude-x")

        state.selectedProvider = "custom:glm"
        state.customProviders = [provider("glm", models: ["glm-5"], enabled: false)]   // disabled
        state.reconcileCustomSelection(activeCLI: "claude_code", defaultModelId: "claude-x")
        #expect(state.selectedProvider == "claude_code")
    }

    @Test("A removed model on a live custom provider falls to its first model")
    func removedCustomModel() {
        let state = CodeAssistantModelState()
        state.selectedProvider = "custom:glm"
        state.selectedModel = "glm-old"
        state.customProviders = [provider("glm", models: ["glm-5", "glm-5-air"])]
        state.reconcileCustomSelection(activeCLI: "claude_code", defaultModelId: "claude-x")
        #expect(state.selectedProvider == "custom:glm" && state.selectedModel == "glm-5")
    }

    @Test("A custom Standard's model is the one the composer starts on")
    func customStandardModel() {
        let state = CodeAssistantModelState()
        state.customProviders = [provider("glm", models: ["glm-5", "glm-5-turbo"])]
        state.selectedProvider = "claude_code"
        let standard = TierRoute(provider: "custom:glm", model: "glm-5-turbo")
        state.applyComposerProvider(overrideId: "glm", activeCLI: "claude_code", defaultModelId: "claude-x",
                                    standard: standard)
        #expect(state.selectedProvider == "custom:glm" && state.selectedModel == "glm-5-turbo")
        // Standard's model changed in Settings: a re-apply follows it unless a model was picked.
        state.applyComposerProvider(overrideId: "glm", activeCLI: "claude_code", defaultModelId: "claude-x",
                                    standard: TierRoute(provider: "custom:glm", model: "glm-5"))
        #expect(state.selectedModel == "glm-5")
        state.selectedModel = "glm-5-turbo"
        state.modelIsExplicit = true
        state.applyComposerProvider(overrideId: "glm", activeCLI: "claude_code", defaultModelId: "claude-x",
                                    standard: TierRoute(provider: "custom:glm", model: "glm-5"))
        #expect(state.selectedModel == "glm-5-turbo", "an explicit composer pick wins")
        // A model the provider does not list: its first model.
        let fresh = CodeAssistantModelState()
        fresh.customProviders = [provider("glm", models: ["glm-5"])]
        fresh.applyComposerProvider(overrideId: "glm", activeCLI: "claude_code", defaultModelId: "claude-x",
                                    standard: standard)
        #expect(fresh.selectedModel == "glm-5")
    }

    @Test("A custom provider's chat takes a mode tier on that provider")
    func customChatTakesItsModeTier() throws {
        let suite = "ChatModelSelectionTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = AppConfig(userDefaults: defaults)
        #expect(TierRoutingConfig(tiers: ["cheap": TierRoute(provider: "custom:glm", model: "glm-5-turbo"),
                                          "strong": TierRoute(provider: "anthropic", model: "claude-opus-5")],
                                  features: ["chatCoding": "cheap", "chatPlanning": "strong"]).save(to: defaults))
        let state = CodeAssistantModelState()
        state.customProviders = [provider("glm", models: ["glm-5", "glm-5-turbo"])]
        state.selectedProvider = "custom:glm"
        state.selectedModel = "glm-5"
        state.pickMode(.execute)
        #expect(state.effectiveModelId(config: config) == "glm-5-turbo")
        state.pickMode(.plan)
        #expect(state.effectiveModelId(config: config) == "glm-5", "an Anthropic tier does not apply to a GLM chat")
        state.modelIsExplicit = true
        state.pickMode(.execute)
        #expect(state.effectiveModelId(config: config) == "glm-5", "an explicit pick still wins")
    }

    @Test("A composer pick no longer edits the default model")
    func composerPickLeavesTheDefault() throws {
        let suite = "ChatModelSelectionTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = AppConfig(userDefaults: defaults)
        config.activeCLI = "claude_code"
        config.defaultModelId = "claude-sonnet-5"
        let state = CodeAssistantModelState()
        state.selectedProvider = AICliTool.claudeCode.rawValue
        state.liveModels[ClaudeCLI.provider] = [AIModel(id: "claude-opus-5", displayName: "Opus 5"),
                                                AIModel(id: "claude-sonnet-5", displayName: "Sonnet 5")]
        #expect(state.resolveModelCommand("opus", config: config) == nil)
        #expect(config.defaultModelId == "claude-sonnet-5", "Standard's model is untouched")
        #expect(config.modelPickIsExplicit && config.explicitModelId == "claude-opus-5")
        state.addCustomModel("claude-next", provider: ClaudeCLI.provider, config: config)
        #expect(config.defaultModelId == "claude-sonnet-5" && config.explicitModelId == "claude-next")
    }

    @Test("A rebuilt composer restores the explicit pick, else the default")
    func restoredModel() {
        #expect(CodeAssistantModelState.restoredModel(isExplicit: true, explicitId: "claude-opus-5",
                                                      defaultModelId: "claude-sonnet-5") == "claude-opus-5")
        // A pick made before this update was persisted only as defaultModelId.
        #expect(CodeAssistantModelState.restoredModel(isExplicit: true, explicitId: "",
                                                      defaultModelId: "claude-sonnet-5") == "claude-sonnet-5")
        #expect(CodeAssistantModelState.restoredModel(isExplicit: false, explicitId: "claude-opus-5",
                                                      defaultModelId: "claude-sonnet-5") == "claude-sonnet-5")
        #expect(CodeAssistantModelState.restoredModel(isExplicit: false, explicitId: "",
                                                      defaultModelId: "") == AICliTool.claudeCode.defaultModelId)
    }

    @Test("The composer provider key is the one Standard's write-through sets")
    func composerKeyIsShared() {
        #expect(CodeAssistantModelState.composerProviderKey == TierDefaults.composerProviderKey)
    }
}
