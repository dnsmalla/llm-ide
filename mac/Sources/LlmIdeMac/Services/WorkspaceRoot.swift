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

    // MARK: - Browsing root (Explorer + Search)

    /// The folder the CODE-BROWSING panels display — Explorer's tree and, as of
    /// P4, Search's walk. This is deliberately narrower than `resolve`: browsing
    /// means code, so it roots at the active project's `code/` folder (where
    /// repos clone to) rather than the whole project, whose `source/`,
    /// `llm-doc/` and `data/` are Library territory.
    ///
    /// The consequence is intentional and worth stating: with a project open,
    /// Search covers `code/` only. Explorer and Search showing different trees
    /// was the bug (design §3 finding #10); this is the single definition that
    /// fixes it.
    ///
    /// MIRROR, NOT YET THE SOURCE. `ExplorerView.root` plus
    /// `ExplorerTreeStore.displayRoot(for:)` still compute this independently
    /// (P4 does not edit `ExplorerView` — P3 had just rewritten its root
    /// handling). This reproduces that pair: pick `code/` else the resolved
    /// workspace root, canonicalize with `ExplorerPaths.canonical(_:)` — the ONE
    /// canonicalization point, and load-bearing here because
    /// `FileManager.contentsOfDirectory` fails `ENOTDIR` on a symlinked
    /// directory URL — then collapse a lone subdirectory. Pointing
    /// `ExplorerView.root` at this function is the follow-up that removes the
    /// duplication; until then, a change to either MUST be made to both.
    ///
    /// ONE DELIBERATE DIVERGENCE: `ExplorerView.root` returns `code/` whenever a
    /// project is open, existing or not. Here a missing `code/` falls back to
    /// the workspace root, because a Search rooted at a folder that isn't there
    /// reports zero results forever, whereas the Explorer merely renders an
    /// empty tree. A brand-new project genuinely has no `code/` — nothing
    /// creates it until a repo is cloned — so this is a live path, not a
    /// defensive flourish.
    ///
    /// NEVER CALL THIS FROM A VIEW `body`. It does synchronous filesystem I/O
    /// (`contentsOfDirectory` + `resolvingSymlinksInPath`) on the main actor and
    /// caches nothing, so a per-render computed `var root` would re-walk the
    /// workspace on every render. Resolve it once into `@State` from a
    /// `.task(id:)`, the way `ExplorerView` stamps `treeRoot` — that is the
    /// pattern the follow-up should copy when it removes the duplication above.
    @MainActor
    static func browsingRoot(config: AppConfig, projectStore: ProjectStore) -> URL? {
        pickBrowsingRoot(codeDir: projectStore.activeProjectCodeDir.map(ExplorerPaths.canonical),
                         fallback: resolve(config: config, projectStore: projectStore)
                             .map(ExplorerPaths.canonical),
                         exists: { FileManager.default.fileExists(atPath: $0.path) },
                         children: { FileSystemTree.children(of: $0) })
            .map(ExplorerPaths.canonical)
    }

    /// Pure decision core, separated for unit tests exactly like `pick` above.
    /// Callers hand it URLs that are ALREADY canonical (see `browsingRoot`);
    /// this function does no path resolution of its own.
    ///
    /// `exists` is load-bearing, not defensive noise — see `browsingRoot`.
    ///
    /// The single-child collapse reproduces `ExplorerTreeStore.displayRoot(for:)`:
    /// a `code/` holding exactly one clone shows that clone as the root rather
    /// than a one-item wrapper. One level only, one `children` call, matching
    /// the store's cost — collapsing deeper would cost an extra directory read
    /// per project switch for no user-visible gain.
    static func pickBrowsingRoot(codeDir: URL?,
                                 fallback: URL?,
                                 exists: (URL) -> Bool,
                                 children: (URL) -> [FileSystemTree.Node]) -> URL? {
        let base: URL?
        if let codeDir, exists(codeDir) { base = codeDir } else { base = fallback }
        guard let base else { return nil }
        let kids = children(base)
        if kids.count == 1, kids[0].isDirectory { return kids[0].url }
        return base
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
