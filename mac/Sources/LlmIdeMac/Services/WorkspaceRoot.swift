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

    // MARK: - Two-root context

    /// A workspace has TWO distinct roots that must not be conflated:
    ///   • `projectRoot` owns generated/system data — `system/faults`, the
    ///     SQLite index, memory. It is the folder `ProjectLayout` is applied to.
    ///   • `gitRoot` is the active git working tree, used for SCM, agent cwd,
    ///     and verify commands. It is `nil` when no working tree exists.
    ///
    /// In the "clone-into-code" model these differ (project root vs
    /// `code/<repo>`); in the "project is a repo" model they're the same URL.
    /// Resolving them together — and routing each consumer to the right one —
    /// is what stops faults from landing in `code/<repo>/system/faults` while
    /// the UI reads `<projectRoot>/system/faults`.
    struct Context {
        let projectRoot: URL
        let gitRoot: URL?
    }

    @MainActor
    static func context(config: AppConfig, projectStore: ProjectStore) -> Context? {
        guard let projectRoot = resolve(config: config, projectStore: projectStore) else { return nil }
        return Context(projectRoot: projectRoot,
                       gitRoot: pickGitRoot(projectRoot: projectRoot,
                                            activeClone: config.activeRepoLocalURL,
                                            isGitRepo: isGitRepo))
    }

    /// The active git working tree, or nil. Convenience over `context(...)`.
    @MainActor
    static func gitWorkingTree(config: AppConfig, projectStore: ProjectStore) -> URL? {
        context(config: config, projectStore: projectStore)?.gitRoot
    }

    /// Pure decision core for the git working tree, separated for unit tests.
    /// Prefers the project root when it is itself a git repo (project-IS-a-repo
    /// model); otherwise the globally-active clone when it's a real repo.
    static func pickGitRoot(projectRoot: URL, activeClone: URL?, isGitRepo: (URL) -> Bool) -> URL? {
        if isGitRepo(projectRoot) { return projectRoot }
        if let clone = activeClone, isGitRepo(clone) { return clone }
        return nil
    }

    static func isGitRepo(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path)
    }
}
