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
        // Claude keeps its stricter rule: an unknown, unmapped id resets.
        #expect(AppConfig.startupModelId(stored: "claude-not-a-model", activeCLI: "claude_code",
                                         knownModelIds: known) == AICliTool.claudeCode.defaultModelId)
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
}
