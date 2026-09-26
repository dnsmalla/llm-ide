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
        AIModel(id: "claude-opus-5[1m]", displayName: "Opus 5 with 1M context"),
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
}
