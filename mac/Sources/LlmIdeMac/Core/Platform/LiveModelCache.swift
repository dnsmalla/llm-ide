import Foundation
import os

/// The last live model list the backend reported for a provider, persisted so
/// every surface that reads `AICliTool.models` — the composer, the menu-bar
/// chat, the Settings picker, and `AppConfig`'s startup id migration — uses
/// it before this launch's first fetch and while offline.
///
/// For Claude the backend asks the Agent SDK for the account's own list
/// (`extension/llm_agent/sdk/models.mjs`), which works for a `claude login`
/// user with no API key. Without this cache the picker showed
/// `ClaudeCLI.fallbackModels` — hardcoded, and stale after every model
/// release — and a live-only pick (e.g. a newer model) was reset to the
/// default on the next launch because the startup migration did not know it.
enum LiveModelCache {
    static let defaultsKey = "LLMIDE_LIVE_MODELS"

    /// Decoded once per process and on every `store`, not on each read:
    /// `AICliTool.models` is read from SwiftUI bodies.
    private static let memory = OSAllocatedUnfairLock<[String: [AIModel]]?>(initialState: nil)

    static func models(for provider: String, defaults: UserDefaults = .standard) -> [AIModel]? {
        let all = memory.withLock { cached -> [String: [AIModel]] in
            if let cached { return cached }
            let decoded = decode(defaults)
            cached = decoded
            return decoded
        }
        guard let list = all[provider], !list.isEmpty else { return nil }
        return list
    }

    static func store(_ models: [AIModel], for provider: String, defaults: UserDefaults = .standard) {
        guard !models.isEmpty else { return }
        memory.withLock { cached in
            var all = cached ?? decode(defaults)
            all[provider] = models
            cached = all
            if let data = try? JSONEncoder().encode(all) {
                defaults.set(data, forKey: defaultsKey)
            }
        }
    }

    /// Test seam: drop the in-memory copy so the next read goes to `defaults`.
    static func resetMemoryForTesting() {
        memory.withLock { $0 = nil }
    }

    private static func decode(_ defaults: UserDefaults) -> [String: [AIModel]] {
        guard let data = defaults.data(forKey: defaultsKey),
              let all = try? JSONDecoder().decode([String: [AIModel]].self, from: data) else { return [:] }
        return all
    }
}
