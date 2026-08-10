import Foundation

/// Single place that wraps a concrete backend in the allow-list guard.
/// Route ALL backend construction through this so every consumer — manual UI
/// and automation — gets enforcement for free.
enum RepoBackendFactory {
    @MainActor
    static func guarded(_ client: RepoBackend, config: AppConfig) -> RepoBackend {
        AllowlistedRepoBackend(wrapping: client, config: config)
    }

    /// Guarded backend for a resolved provider kind — the single spot that
    /// replaces the `kind == .gitlab ? GitLabClient(...) : GitHubClient(...)`
    /// ternary repeated at every issue/PR/git-op call site.
    @MainActor
    static func backend(for kind: RepoBackendKind, config: AppConfig) -> RepoBackend {
        switch kind {
        case .gitlab: return guarded(GitLabClient(config: config), config: config)
        case .github: return guarded(GitHubClient(config: config), config: config)
        }
    }
}
