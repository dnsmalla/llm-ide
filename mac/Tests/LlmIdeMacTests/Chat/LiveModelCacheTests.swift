import Testing
import Foundation
@testable import LlmIdeMacLib

/// The Claude model picker follows the account's live list (the Agent SDK's,
/// via the backend) instead of a hardcoded one that went stale on every model
/// release — and a pick only that live list knows survives a relaunch.
@MainActor
@Suite("Live model cache", .serialized)
struct LiveModelCacheTests {
    private let live = [
        AIModel(id: "claude-opus-5[1m]", displayName: "Opus 5 (1M)"),
        AIModel(id: "claude-fable-5-1", displayName: "Fable 5.1"),
        AIModel(id: "claude-sonnet-5", displayName: "Sonnet 5"),
    ]

    @Test("store → models round-trips through UserDefaults, and an empty list is never stored")
    func roundTrip() throws {
        let defaults = try #require(UserDefaults(suiteName: "LiveModelCacheTests.\(UUID().uuidString)"))
        LiveModelCache.resetMemoryForTesting()
        defer { LiveModelCache.resetMemoryForTesting() }
        #expect(LiveModelCache.models(for: "anthropic", defaults: defaults) == nil)
        LiveModelCache.store(live, for: "anthropic", defaults: defaults)
        LiveModelCache.store([], for: "anthropic", defaults: defaults)
        // A fresh process (memory dropped) reads it back from disk.
        LiveModelCache.resetMemoryForTesting()
        #expect(LiveModelCache.models(for: "anthropic", defaults: defaults) == live)
        #expect(LiveModelCache.models(for: "openai", defaults: defaults) == nil)
    }

    @Test("Claude's model list — and so its default — follows the live list once fetched")
    func claudeFollowsLiveList() {
        let standard = UserDefaults.standard
        let saved = standard.data(forKey: LiveModelCache.defaultsKey)
        LiveModelCache.resetMemoryForTesting()
        defer {
            if let saved { standard.set(saved, forKey: LiveModelCache.defaultsKey) }
            else { standard.removeObject(forKey: LiveModelCache.defaultsKey) }
            LiveModelCache.resetMemoryForTesting()
        }
        standard.removeObject(forKey: LiveModelCache.defaultsKey)
        LiveModelCache.resetMemoryForTesting()
        #expect(AICliTool.claudeCode.models == ClaudeCLI.fallbackModels, "before any fetch: the first-run list")

        LiveModelCache.store(live, for: ClaudeCLI.provider)
        #expect(AICliTool.claudeCode.models == live)
        #expect(AICliTool.claudeCode.defaultModelId == "claude-opus-5[1m]")
        // Other providers keep their own lists: a long /models listing must not
        // silently become their default.
        #expect(AICliTool.openai.models.first?.id != "claude-opus-5[1m]")

        // A pick only the live list offers survives a relaunch…
        let known = Set(AICliTool.selectable.flatMap { $0.models.map(\.id) })
            .union(ClaudeCLI.fallbackModels.map(\.id))
        #expect(AppConfig.startupModelId(stored: "claude-fable-5-1", activeCLI: "claude_code",
                                         knownModelIds: known) == "claude-fable-5-1")
        // …and so does a first-run id the live list no longer offers.
        #expect(AppConfig.startupModelId(stored: "claude-opus-4-8", activeCLI: "claude_code",
                                         knownModelIds: known) == "claude-opus-4-8")
    }

    @Test("A saved pick missing from the live list keeps its own name, never the first model's")
    func selectedModelKeepsItsName() {
        // Regression: the chip showed the FIRST live model's name ("Opus 5
        // (1M)") while the chat sent "claude-opus-5", which the account's live
        // list does not carry.
        // Named from the LIVE entry for the same model, not a hardcoded table.
        #expect(AIModel.knownName(for: "claude-opus-5", in: live) == "Opus 5")
        #expect(AIModel.knownName(for: "claude-opus-5[1m]", in: live) == "Opus 5 (1M)")
        #expect(AIModel.knownName(for: "claude-sonnet-5-20260101", in: live) == "Sonnet 5", "date snapshot")
        #expect(AIModel.knownName(for: "claude-opus-4-8", in: live) == nil, "no live match: no guessed name")
        let withPick = AIModel.including(selected: "claude-opus-5", in: live)
        #expect(withPick.last == AIModel(id: "claude-opus-5", displayName: "Opus 5"))
        #expect(AIModel.including(selected: "claude-sonnet-5", in: live) == live, "already listed")
        #expect(AIModel.including(selected: "gpt-5.5", in: live) == live, "not a Claude id")
        // …and the quick chat SENDS that pick rather than swapping in the default.
        #expect(QuickChatContext.effectiveModelId(explicit: "claude-opus-5", defaultModelId: "claude-opus-5[1m]",
                                                  models: live) == "claude-opus-5")
        #expect(QuickChatContext.modelLabel(modelId: "claude-opus-5", defaultModelId: "claude-opus-5[1m]",
                                            models: live) == "Opus 5")
        // A non-Claude id under Claude is still not offered: the default wins.
        #expect(QuickChatContext.effectiveModelId(explicit: "gpt-5.5", defaultModelId: "claude-opus-5[1m]",
                                                  models: live) == "claude-opus-5[1m]")
    }
}
