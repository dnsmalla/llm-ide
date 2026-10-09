import Testing
import Foundation
@testable import LlmIdeMacLib

/// The composer's model menu lists every provider that is set up, grouped,
/// not only Settings' default; a pick on another provider applies to the
/// displayed chat only, and an empty chat takes that provider's engine.
@MainActor
@Suite("Composer provider menu", .serialized)
struct ComposerProviderMenuTests {
    private func state(selected provider: String, model: String, keys: Set<String>) -> CodeAssistantModelState {
        let s = CodeAssistantModelState()
        s.selectedProvider = provider
        s.selectedModel = model
        s.configuredSecretKeys = keys
        s.liveModels = ["deepseek": [AIModel(id: "deepseek-flash", displayName: "deepseek-flash"),
                                     AIModel(id: "deepseek-v4-pro", displayName: "deepseek-v4-pro")]]
        return s
    }

    @Test("Claude, keyed built-ins and enabled custom providers are listed; unkeyed built-ins are not")
    func listsSetUpProviders() {
        let s = state(selected: AICliTool.deepseek.rawValue, model: "deepseek-flash", keys: ["deepseek.apiKey"])
        var custom = CustomProvider(name: "Relay", baseURL: "https://relay.example/v1", apiKey: "k",
                                    models: [AIModel(id: "relay-1", displayName: "relay-1")])
        var off = CustomProvider(name: "Off", baseURL: "https://off.example/v1", apiKey: "k",
                                 models: [AIModel(id: "off-1", displayName: "off-1")])
        off.isEnabled = false
        custom.isEnabled = true
        s.customProviders = [custom, off]

        let ids = s.composerProviderSections(capableProviders: [AgentV2Selection.anthropicProvider]).map(\.id)
        #expect(ids.contains(AICliTool.claudeCode.rawValue))
        #expect(ids.contains(AICliTool.deepseek.rawValue))
        #expect(ids.contains(custom.wireId))
        #expect(!ids.contains(off.wireId))
        #expect(!ids.contains(AICliTool.openai.rawValue), "no key stored")
    }

    @Test("the selected model is listed under its provider even when the live list dropped it")
    func selectedModelIsAlwaysListed() {
        let s = state(selected: AICliTool.deepseek.rawValue, model: "deepseek-chat", keys: ["deepseek.apiKey"])
        let deepseek = s.composerProviderSections(capableProviders: [])
            .first { $0.id == AICliTool.deepseek.rawValue }
        #expect(deepseek?.models.map(\.id).contains("deepseek-chat") == true)
        let claude = s.composerProviderSections(capableProviders: [])
            .first { $0.id == AICliTool.claudeCode.rawValue }
        #expect(claude?.models.map(\.id).contains("deepseek-chat") == false, "never under another provider")
    }

    @Test("a chat already on the Agent engine cannot move to a classic-only provider; empty or classic chats can")
    func pickability() {
        let classic = ComposerProviderSection(id: "deepseek", title: "DeepSeek", models: [], runsOnAgentEngine: false)
        let agent = ComposerProviderSection(id: "claude_code", title: "Claude", models: [], runsOnAgentEngine: true)
        #expect(!CodeAssistantModelState.canPick(classic, chatIsEmpty: false, chatRunsOnAgentEngine: true))
        #expect(CodeAssistantModelState.canPick(agent, chatIsEmpty: false, chatRunsOnAgentEngine: true))
        #expect(CodeAssistantModelState.canPick(classic, chatIsEmpty: true, chatRunsOnAgentEngine: true))
        #expect(CodeAssistantModelState.canPick(agent, chatIsEmpty: false, chatRunsOnAgentEngine: false))
    }

    @Test("a pick on another provider is this chat's only, survives Settings' re-apply, and is restored on return")
    func perChatPick() {
        let chatA = UUID().uuidString, chatB = UUID().uuidString
        defer { ComposerProviderPicks.bySession[chatA] = nil; ComposerProviderPicks.bySession[chatB] = nil }
        let s = state(selected: AICliTool.deepseek.rawValue, model: "deepseek-flash", keys: ["deepseek.apiKey"])

        s.pick(model: "claude-sonnet-5", provider: AICliTool.claudeCode.rawValue, sessionID: chatA,
               settingsProvider: AICliTool.deepseek.rawValue)
        s.applyComposerProvider(overrideId: "", activeCLI: AICliTool.deepseek.rawValue, defaultModelId: "deepseek-flash")
        #expect(s.selectedProvider == AICliTool.claudeCode.rawValue, "Settings' re-apply leaves the pick alone")

        // Chat B has no pick: back on Settings' provider.
        #expect(!s.restoreProviderPick(for: chatB))
        s.applyComposerProvider(overrideId: "", activeCLI: AICliTool.deepseek.rawValue, defaultModelId: "deepseek-flash")
        #expect(s.selectedProvider == AICliTool.deepseek.rawValue)

        // Back to chat A: its pick returns.
        #expect(s.restoreProviderPick(for: chatA))
        #expect(s.selectedProvider == AICliTool.claudeCode.rawValue && s.selectedModel == "claude-sonnet-5")

        // Picking Settings' own provider clears the chat's override.
        s.pick(model: "deepseek-v4-pro", provider: AICliTool.deepseek.rawValue, sessionID: chatA,
               settingsProvider: AICliTool.deepseek.rawValue)
        #expect(ComposerProviderPicks.bySession[chatA] == nil && !s.providerIsExplicit)
    }

    private func freshConfig() -> AppConfig {
        AppConfig(userDefaults: UserDefaults(suiteName: "composer-menu-\(UUID().uuidString)")!)
    }

    @Test("/model and Add model on a per-chat provider update that chat's pick, never Settings' saved model")
    func modelChoiceOnPerChatProvider() {
        let chat = UUID().uuidString
        defer { ComposerProviderPicks.bySession[chat] = nil }
        let config = freshConfig()
        config.modelPickIsExplicit = true
        config.explicitModelId = "claude-opus-5"
        let s = state(selected: AICliTool.claudeCode.rawValue, model: "claude-opus-5", keys: ["deepseek.apiKey"])
        s.pick(model: "deepseek-flash", provider: AICliTool.deepseek.rawValue, sessionID: chat,
               settingsProvider: AICliTool.claudeCode.rawValue)

        #expect(s.resolveModelCommand("v4-pro", config: config) == nil)
        #expect(config.explicitModelId == "claude-opus-5", "Settings' saved Claude pick is untouched")
        #expect(ComposerProviderPicks.bySession[chat] == ProviderPick(provider: AICliTool.deepseek.rawValue,
                                                                       model: "deepseek-v4-pro"))
        // On Settings' own provider the pick is still persisted as before.
        s.pick(model: "claude-sonnet-5", provider: AICliTool.claudeCode.rawValue, sessionID: chat,
               settingsProvider: AICliTool.claudeCode.rawValue)
        s.persistModelChoice("claude-sonnet-5", config: config)
        #expect(config.explicitModelId == "claude-sonnet-5")
    }

    @Test("leaving a chat with its own provider restores the user's saved model, not Standard's")
    func leavingPerChatPickRestoresSavedModel() {
        let chatA = UUID().uuidString
        defer { ComposerProviderPicks.bySession[chatA] = nil }
        let config = freshConfig()
        config.modelPickIsExplicit = true
        config.explicitModelId = "claude-opus-5"
        let s = state(selected: AICliTool.claudeCode.rawValue, model: "claude-opus-5", keys: ["deepseek.apiKey"])
        s.pick(model: "deepseek-flash", provider: AICliTool.deepseek.rawValue, sessionID: chatA,
               settingsProvider: AICliTool.claudeCode.rawValue)

        // Switch to chat B, which follows Settings (what ChatComposer's onChange does).
        #expect(!s.restoreProviderPick(for: UUID().uuidString))
        s.applyComposerProvider(overrideId: "", activeCLI: AICliTool.claudeCode.rawValue, defaultModelId: "claude-sonnet-5")
        s.restoreSettingsModel(config: config)
        #expect(s.selectedProvider == AICliTool.claudeCode.rawValue)
        #expect(s.selectedModel == "claude-opus-5" && s.modelIsExplicit)
    }

    @Test("the error banner is hidden when it only repeats the last failed reply's error")
    func bannerDedupe() {
        var failed = ChatMessage(role: .assistant, content: "", status: .failed, createdAt: Date())
        failed.metadata = ChatMessage.Metadata(failedError: "HTTP 404")
        let user = ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date())
        #expect(ChatEngine.errorIsShownOnLastReply("HTTP 404", messages: [user, failed]))
        #expect(!ChatEngine.errorIsShownOnLastReply("Couldn't apply the edit", messages: [user, failed]),
                "an error the reply does not show keeps the banner")
        #expect(!ChatEngine.errorIsShownOnLastReply("HTTP 404", messages: [failed, user]))
    }

    @Test("an empty chat is re-stamped for the provider picked; a chat with messages keeps its engine")
    func restampOnlyWhenEmpty() async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("composer-restamp-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer {
            ChatSessionStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: tmp)
        }
        let capable: Set<String> = [AgentV2Selection.anthropicProvider]
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        engine.resolveNewChatProvider = { "deepseek" }
        engine.mintFreshSession()
        let toggleOn = AgentV2Selection.toggleEnabled()

        engine.restampEngineIfEmpty(resolvedProvider: AgentV2Selection.anthropicProvider, capableProviders: capable)
        #expect(engine.currentSessionEngineMarker() == (toggleOn ? AgentV2Selection.sessionEngineV2 : nil))

        engine.messages = [ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date())]
        engine.restampEngineIfEmpty(resolvedProvider: "deepseek", capableProviders: capable)
        #expect(engine.currentSessionEngineMarker() == (toggleOn ? AgentV2Selection.sessionEngineV2 : nil),
                "a chat with messages keeps the engine it has")
    }
}
