import Testing
import Foundation
@testable import LlmIdeMacLib

/// Catalog models in the chat's model menu (K1 Phase 6 T6.6): the tools badge, the router-off and
/// provider-chat-off notes, the pin a pick implies, and the engine-capability set.
@MainActor
@Suite("Composer catalog models", .serialized)
struct ComposerCatalogTests {
    private func model(_ id: String, tools: Bool) -> LlmIdeAPIClient.CatalogModel {
        .init(id: id, toolsSupported: tools, toolsSource: "catalog", streaming: true, contextWindow: nil)
    }
    private var deepseek: CatalogConnectionSummary {
        .init(wireId: "custom:cat-deepseek", name: "DeepSeek",
              models: [model("deepseek-chat", tools: true), model("deepseek-reasoner", tools: false)])
    }
    private func state() -> CodeAssistantModelState {
        let s = CodeAssistantModelState()
        s.selectedProvider = AICliTool.claudeCode.rawValue
        s.selectedModel = "claude-test"
        s.liveModels = [AICliTool.claudeCode.provider: [AIModel(id: "claude-test", displayName: "claude-test")]]
        s.catalogConnections = [deepseek]
        s.catalogProviderChatEnabled = true
        return s
    }

    @Test("a catalog section carries the tools flag per model and is pickable with the router on")
    func sectionWithRouterOn() throws {
        let sections = state().composerProviderSections(capableProviders: [AgentV2Selection.anthropicProvider], routerOn: true)
        let ds = try #require(sections.first { $0.id == "custom:cat-deepseek" })
        #expect(ds.catalog && ds.unavailableNote == nil && ds.runsOnAgentEngine)
        #expect(ds.toolsByModel == ["deepseek-chat": true, "deepseek-reasoner": false])
        #expect(CodeAssistantModelState.canPick(ds, chatIsEmpty: false, chatRunsOnAgentEngine: true))
        #expect(ComposerCatalog.modelMenuTitle(ds.models[0], in: ds) == "deepseek-chat  (tools)")
        #expect(ComposerCatalog.modelMenuTitle(ds.models[1], in: ds) == "deepseek-reasoner  (no tools)")
    }

    @Test("router OFF: the models are shown but disabled, with the note to turn the router on; nothing is enabled silently")
    func routerOffDisables() throws {
        let sections = state().composerProviderSections(capableProviders: [AgentV2Selection.anthropicProvider], routerOn: false)
        let ds = try #require(sections.first { $0.id == "custom:cat-deepseek" })
        #expect(ds.unavailableNote == ComposerCatalog.routerOffNote)
        #expect(ds.unavailableNote?.contains("session router") == true)
        #expect(!CodeAssistantModelState.canPick(ds, chatIsEmpty: true, chatRunsOnAgentEngine: false))
        #expect(!ds.runsOnAgentEngine)
    }

    @Test("tools off in the catalog settings: the section stays pickable (ask works), with a visible note and switch")
    func toolsOff() throws {
        let s = state()
        s.catalogProviderChatEnabled = false
        let ds = try #require(s.composerProviderSections(capableProviders: [], routerOn: true).first { $0.catalog })
        #expect(ds.unavailableNote == nil)
        #expect(CodeAssistantModelState.canPick(ds, chatIsEmpty: true, chatRunsOnAgentEngine: true))
        #expect(ds.infoNote == ComposerCatalog.toolsOffNote)
        #expect(ComposerCatalog.toolsSwitchLabel == "Allow tools on provider models")
        #expect(ComposerCatalog.toolsExplanation.contains("read files and run commands"))
        s.catalogProviderChatEnabled = true
        let on = try #require(s.composerProviderSections(capableProviders: [], routerOn: true).first { $0.catalog })
        #expect(on.infoNote == nil)
    }

    @Test("with the router on a catalog model is pickable in any chat, empty or not")
    func pickableInAnyChat() throws {
        let ds = try #require(state().composerProviderSections(capableProviders: [], routerOn: true).first { $0.catalog })
        #expect(CodeAssistantModelState.canPick(ds, chatIsEmpty: false, chatRunsOnAgentEngine: true))
        #expect(CodeAssistantModelState.canPick(ds, chatIsEmpty: true, chatRunsOnAgentEngine: true))
    }

    @Test("a connection with no models, or none connected, adds no section")
    func emptyConnections() {
        let s = state()
        s.catalogConnections = [.init(wireId: "custom:cat-groq", name: "Groq", models: [])]
        #expect(s.composerProviderSections(capableProviders: [], routerOn: true).allSatisfy { !$0.catalog })
        s.catalogConnections = []
        #expect(s.composerProviderSections(capableProviders: [], routerOn: true).allSatisfy { !$0.catalog })
    }

    @Test("a catalog pick pins the route; any other pick releases a catalog pin and leaves other pins alone")
    func pinActions() {
        #expect(ComposerCatalog.pinAction(pickedProvider: "custom:cat-deepseek", pickedModel: "deepseek-chat", currentPinnedProvider: nil)
                == .pin(provider: "custom:cat-deepseek", model: "deepseek-chat"))
        #expect(ComposerCatalog.pinAction(pickedProvider: "anthropic", pickedModel: "claude-x", currentPinnedProvider: "custom:cat-deepseek") == .unpin)
        #expect(ComposerCatalog.pinAction(pickedProvider: "anthropic", pickedModel: "claude-x", currentPinnedProvider: nil) == nil)
        #expect(ComposerCatalog.pinAction(pickedProvider: "anthropic", pickedModel: "claude-x", currentPinnedProvider: "anthropic") == nil)
    }

    @Test("the Agent engine runs a catalog connection while the router is on (tools are a separate opt-in)")
    func capability() {
        let cap = CatalogConnectionIndex.shared
        cap.update(connections: [deepseek], providerChatEnabled: true)
        #expect(cap.capableWireIds(routerOn: true) == ["custom:cat-deepseek"])
        #expect(cap.capableWireIds(routerOn: false).isEmpty)
        cap.update(connections: [deepseek], providerChatEnabled: false)
        #expect(cap.capableWireIds(routerOn: true) == ["custom:cat-deepseek"], "ask chat needs only the router")
        cap.update(connections: [], providerChatEnabled: false)
        let capable = AgentV2Selection.agentCapableProviders(customProviders: [], catalogWireIds: ["custom:cat-deepseek"])
        #expect(AgentV2Selection.canRunChat("custom:cat-deepseek", capableProviders: capable))
        #expect(!AgentV2Selection.canRunChat("custom:cat-deepseek",
                                             capableProviders: AgentV2Selection.agentCapableProviders(customProviders: [])))
    }
}

/// DeepSeek (a catalog connection) through the engine-selection transport: the turn goes to
/// /agent/v2/stream with the catalog provider and model, never to the classic /code-assist transport.
@MainActor
@Suite("Catalog provider turns use the Agent v2 stream", .serialized)
struct CatalogTransportTests {
    private func input() -> ChatTransportInput {
        ChatTransportInput(message: "hello", history: [], attachments: [], skills: [], agentContext: nil,
                           language: nil, model: "deepseek-chat", provider: "custom:cat-deepseek", mode: "ask")
    }
    private func turn() -> [AgentV2Event] {
        [.init_(AgentV2Init(sessionId: "adapter-1", claudeCodeVersion: nil, model: "deepseek-chat", tools: ["search-kb"],
                            capabilities: ["provider-adapter"], mcpServers: [])),
         .delta("from deepseek"),
         .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil, durationMs: nil, sessionId: nil, stopReason: nil))]
    }

    @Test("router on: the catalog turn runs on the v2 stream with provider and model in the body")
    func routedToV2() async throws {
        let stream = QueuedAgentV2Stream()
        stream.turns = [turn()]
        let composite = AgentV2EngineTransport(
            v2: AgentV2Transport(streamer: stream),
            capableProviders: { AgentV2Selection.agentCapableProviders(customProviders: [], catalogWireIds: ["custom:cat-deepseek"]) })
        let result = try await composite.roundTrip(input(), onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        #expect(result.reply == "from deepseek")
        #expect(stream.bodies.first?["provider"] as? String == "custom:cat-deepseek")
        #expect(stream.bodies.first?["model"] as? String == "deepseek-chat")
    }

    @Test("router OFF with a catalog model still selected: the turn fails before any request with the unsupported message")
    func routerOffSelectedCatalogModel() async {
        let stream = QueuedAgentV2Stream()
        let composite = AgentV2EngineTransport(
            v2: AgentV2Transport(streamer: stream),
            capableProviders: { AgentV2Selection.agentCapableProviders(customProviders: [], catalogWireIds: CatalogConnectionIndex.shared.capableWireIds(routerOn: false)) })
        CatalogConnectionIndex.shared.update(connections: [CatalogConnectionSummary(wireId: "custom:cat-deepseek", name: "DeepSeek", models: [])],
                                             providerChatEnabled: true)
        await #expect(throws: ChatProviderUnsupportedError.self) {
            _ = try await composite.roundTrip(self.input(), onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        }
        #expect(stream.bodies.isEmpty)
    }

    @Test("a refusal such as MODEL_LACKS_TOOLS reaches the user with the server's own message")
    func refusalMessage() async {
        let stream = QueuedAgentV2Stream()
        stream.turns = [[.error(code: "MODEL_LACKS_TOOLS", message: "deepseek-reasoner is not known to support tools, and plan mode needs them. Pick a model with the tools badge.")]]
        let composite = AgentV2EngineTransport(
            v2: AgentV2Transport(streamer: stream),
            capableProviders: { AgentV2Selection.agentCapableProviders(customProviders: [], catalogWireIds: ["custom:cat-deepseek"]) })
        do {
            _ = try await composite.roundTrip(input(), onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
            Issue.record("expected a refusal")
        } catch {
            #expect(error.localizedDescription.contains("tools badge"), "\(error.localizedDescription)")
        }
    }
}

/// Catalog connections as a tier route (background roles on Strong / Cheap).
@MainActor
@Suite("Tier routes on catalog connections", .serialized)
struct CatalogTierRouteTests {
    private let route = TierRoute(provider: "custom:cat-deepseek", model: "deepseek-chat")
    private func seed(_ ids: [String], chat: Bool = true) {
        CatalogConnectionIndex.shared.update(
            connections: ids.map { CatalogConnectionSummary(wireId: $0, name: $0, models: []) }, providerChatEnabled: chat)
    }

    @Test("a known connection is usable for a background role; a removed one says so")
    func knownAndRemoved() {
        seed(["custom:cat-deepseek"])
        #expect(TierRouting.unusableReason(route, customProviders: []) == nil)
        seed([])
        #expect(TierRouting.unusableReason(route, customProviders: [])?.contains("removed or disabled") == true)
    }

    @Test("an Auto Task (local CLI) role never takes it")
    func noLocalCli() {
        seed(["custom:cat-deepseek"])
        #expect(TierRouting.unusableReason(route, customProviders: [], localCLIOnly: true)?.contains("no local CLI") == true)
    }

    @Test("a chat role (Agent engine) needs the router and provider chat")
    func chatRole() {
        seed(["custom:cat-deepseek"], chat: false)
        #expect(TierRouting.unusableReason(route, customProviders: [], requiresAgentEngine: true) != nil)
        seed(["custom:cat-deepseek"], chat: true)
        // router preference off in the test process: still refused
        #expect(TierRouting.unusableReason(route, customProviders: [], requiresAgentEngine: true) != nil
                || ChatRoutePreference.routerEnabled())
    }
}

/// The upgrade path: carried-over keys, the router switch offered inline, never enabled silently.
@MainActor
@Suite("Catalog upgrade path", .serialized)
struct CatalogUpgradePathTests {
    private func section(routerOn: Bool, pref: Bool = false) throws -> ComposerProviderSection {
        let c = CatalogConnectionSummary(wireId: "custom:cat-deepseek", name: "DeepSeek", models: [
            .init(id: "deepseek-chat", toolsSupported: true, toolsSource: "catalog", streaming: true, contextWindow: nil)])
        return try #require(ComposerCatalog.sections([c], routerOn: routerOn, providerChatEnabled: true, routerPrefOn: pref).first)
    }

    @Test("router off: the section offers the one-click switch; it is still disabled (nothing is enabled silently)")
    func offersSwitch() throws {
        let s = try section(routerOn: false)
        #expect(ComposerCatalog.offersRouterSwitch(s))
        #expect(!CodeAssistantModelState.canPick(s, chatIsEmpty: true, chatRunsOnAgentEngine: true))
        #expect(ComposerCatalog.routerSwitchLabel.contains("next backend start"))
    }

    @Test("pref on but the running backend has not restarted: the note says it applies at the next start and no switch is offered")
    func pendingRestart() throws {
        let s = try section(routerOn: false, pref: true)
        #expect(s.unavailableNote == ComposerCatalog.routerPendingNote)
        #expect(s.unavailableNote?.contains("next time the backend starts") == true)
        #expect(!ComposerCatalog.offersRouterSwitch(s))
    }

    @Test("router on: pickable, no switch offered")
    func routerOn() throws {
        let s = try section(routerOn: true)
        #expect(s.unavailableNote == nil && !ComposerCatalog.offersRouterSwitch(s))
    }

    @Test("the migration block decodes, and an older server's catalog without it still decodes")
    func decodesMigration() throws {
        let base = #"{"providers":[],"settings":{"toolsEnabled":true,"fallbackEnabled":false,"fallbackOrder":[],"toolOverrides":{},"egressAutoApprove":false}"#
        let with = try JSONDecoder().decode(LlmIdeAPIClient.CatalogResponse.self, from: Data((base + #","migration":{"created":[{"provider":"deepseek","name":"DeepSeek"}],"needsReview":[{"provider":"custom:lan","name":"Lab box","reason":"private address"}],"toolsSuggested":true}}"#).utf8))
        #expect(with.migration?.created.map(\.name) == ["DeepSeek"])
        #expect(with.migration?.toolsSuggested == true)
        #expect(with.migration?.needsReview.first?.reason == "private address")
        let without = try JSONDecoder().decode(LlmIdeAPIClient.CatalogResponse.self, from: Data((base + "}").utf8))
        #expect(without.migration == nil)
    }

    @Test("the words: created connections keep the old keys; a skipped one says why; the router needs a restart")
    func text() {
        #expect(ProviderMigrationText.createdLine(["DeepSeek"]).contains("The old keys are kept"))
        #expect(ProviderMigrationText.createdLine(["DeepSeek", "OpenAI"]).contains("DeepSeek, OpenAI keys were"))
        #expect(ProviderMigrationText.reviewLine(name: "Lab box", reason: "private address").contains("needs review"))
        #expect(ProviderMigrationText.routerNeeded.contains("next time the backend starts"))
    }
}
