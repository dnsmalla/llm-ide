import Foundation

/// Single place that wraps a concrete backend in the allow-list guard.
/// Route ALL backend construction through this so every consumer — manual UI
/// and automation — gets enforcement for free.
enum RepoBackendFactory {
    @MainActor
    static func guarded(_ client: RepoBackend, config: AppConfig) -> RepoBackend {
        AllowlistedRepoBackend(wrapping: client, config: config)
    }
}
