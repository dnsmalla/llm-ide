import Foundation

/// The indexed code repositories an agent turn is grounded in —
/// `AgentContext.indexedRepos`.
///
/// Two things read it server-side, and the second is why an empty list is not
/// merely a thinner prompt:
///  1. `render-indexed-repos.mjs` renders `## Indexed code repositories`, or
///     "(none indexed)" — so an empty list tells the model the user has no
///     indexed repos, which is a false statement rather than a missing one.
///  2. `memory-persist.mjs` takes the FIRST indexed repo as the root to write
///     captured project memory into, falling back to the workspace root. So a
///     surface that sends none writes its memory somewhere else than a surface
///     that sends them — facts captured from the phone would not come back on
///     the Mac.
///
/// Derived from `config.localCodeFolders` (the folders the Library references
/// in place) so it needs no `LibraryItemStore`: that store is created by
/// `AppShell`, long after the mobile stack boots, and is not reachable from a
/// background bridge. The Code Assistant panel keeps its own Library-derived
/// list, which is a SUPERSET — it also groups code found inside the project
/// itself. That part is already named to the model by `activeProject` and
/// `workspaceRoot`, which every surface sends; what only the panel had was
/// these external repos.
@MainActor
enum IndexedReposResolver {

    /// The external code folders as `AgentContext.IndexedRepo`s — the folder's
    /// own name (what `LibraryItemStore` uses as each item's `folderOrigin`)
    /// and its path, home-relative so a username doesn't ride into the prompt.
    static func externalRepos(config: AppConfig) -> [AgentContext.IndexedRepo] {
        config.localCodeFolders.compactMap { path in
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            let url = URL(fileURLWithPath: trimmed)
            let name = url.lastPathComponent
            guard !name.isEmpty else { return nil }
            return AgentContext.IndexedRepo(name: name, path: PathUtils.homeRelative(url.path))
        }
    }
}
