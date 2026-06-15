import Foundation

/// Single source of truth for resolving the active workspace root. Previously
/// reimplemented (inconsistently) in AppShell, StatusBar, ExplorerView, and
/// SearchView. Prefers the active cloned repo (if it exists on disk), then the
/// active project folder (if it exists), else nil.
enum WorkspaceRoot {
    @MainActor
    static func resolve(config: AppConfig, projectStore: ProjectStore) -> URL? {
        if let repo = config.activeRepoLocalURL,
           FileManager.default.fileExists(atPath: repo.path) {
            return repo
        }
        if let path = projectStore.activeProject?.localPath,
           !path.isEmpty,
           FileManager.default.fileExists(atPath: path) {
            return URL(fileURLWithPath: path)
        }
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
