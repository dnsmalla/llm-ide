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
    /// Serializes `store`s so they persist in order. Readers never take it.
    private static let persistLock = NSLock()

    static func models(for provider: String, defaults: UserDefaults = .standard) -> [AIModel]? {
        let all: [String: [AIModel]]
        if let cached = memory.withLock({ $0 }) {
            all = cached
        } else {
            // Decoded outside the lock (`UserDefaults` is not `Sendable`). Two
            // first reads may both decode; the first to publish wins, and a
            // `store` that landed in between is kept rather than overwritten.
            let decoded = decode(defaults)
            all = memory.withLock { cached in
                if let cached { return cached }
                cached = decoded
                return decoded
            }
        }
        guard let list = all[provider], !list.isEmpty else { return nil }
        return list
    }

    static func store(_ models: [AIModel], for provider: String, defaults: UserDefaults = .standard) {
        guard !models.isEmpty else { return }
        // `defaults.set` must NOT run under `memory`: it posts
        // UserDefaults.didChange synchronously on the storing thread, and
        // SwiftUI's @AppStorage observer then waits for the view-update lock.
        // A body reading `models(for:)` holds that update lock while waiting
        // for `memory` — a deadlock that froze the app at launch. So the merge
        // happens under `memory` (readers' lock), the persist under
        // `persistLock` only, which keeps concurrent stores in order without
        // ever making a reader wait on a UserDefaults write. `UserDefaults` is
        // documented thread-safe; it is only non-`Sendable` by declaration.
        persistLock.lock(); defer { persistLock.unlock() }
        let all = memory.withLockUnchecked { cached -> [String: [AIModel]] in
            var all = cached ?? decode(defaults)
            all[provider] = models
            cached = all
            return all
        }
        if let data = try? JSONEncoder().encode(all) {
            defaults.set(data, forKey: defaultsKey)
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
