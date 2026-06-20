import Foundation

/// Single source of truth for resolving the active workspace root, shared by
/// the Explorer, Source Control, Search, and the terminal so they always agree.
///
/// The **active project is the source of truth**. A cloned code repo is itself
/// adopted as a project (see GitHubSettingsSection / GitLabSettingsSection), so
/// when the user is working in a repo it IS the active project and the root is
/// its folder. A fresh project with no repo set up roots at its own folder
/// (source/code/data/notes) — it must NOT inherit whichever repo
/// happened to be marked active globally in Settings, which is the bug this
/// ordering fixes. The globally-active cloned repo is only a fallback for the
/// no-active-project case (e.g. first launch / repo-only usage).
enum WorkspaceRoot {
    @MainActor
    static func resolve(config: AppConfig, projectStore: ProjectStore) -> URL? {
        pick(projectPath: projectStore.activeProject?.localPath,
             fallbackRepo: config.activeRepoLocalURL,
             exists: { FileManager.default.fileExists(atPath: $0.path) })
    }

    /// Pure decision core, separated so it can be unit-tested without a live
    /// AppConfig/ProjectStore. Prefers the active project folder; falls back to
    /// the globally-active cloned repo only when no project folder is usable.
    static func pick(projectPath: String?, fallbackRepo: URL?, exists: (URL) -> Bool) -> URL? {
        if let path = projectPath, !path.isEmpty {
            let url = URL(fileURLWithPath: path)
            if exists(url) { return url }
        }
        if let repo = fallbackRepo, exists(repo) { return repo }
        return nil
    }

    /// Same, but falls back to the user's home dir for contexts that need a
    /// real cwd (e.g. spawning a terminal).
    @MainActor
    static func resolveOrHome(config: AppConfig, projectStore: ProjectStore) -> URL {
        resolve(config: config, projectStore: projectStore)
            ?? FileManager.default.homeDirectoryForCurrentUser
    }
}
