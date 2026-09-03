import Foundation
import Observation

/// The Explorer file tree's model — children cache, expansion set, and
/// selection — extracted from `ExplorerView`'s `@State`.
///
/// Why this exists (design §3, finding #9): `ExplorerView.children(of:)` wrote
/// into a `@State` dictionary from inside `body`, which SwiftUI explicitly
/// forbids ("Modifying state during view update"). Moving the cache into an
/// `@Observable` model with an explicit `async` load makes the write happen in
/// a task, not during view evaluation, and makes every rule here testable
/// without a UI.
///
/// The split that keeps that fix honest: every accessor a `body` may call
/// (`children(of:)`, `isLoaded(_:)`, `displayRoot(for:)`, `flatten(from:)`) is
/// pure — it reads the cache and never writes it, never touches the
/// filesystem. Everything that mutates is either `async` (so it can only be
/// reached from a task or lifecycle hook) or an explicit event handler.
///
/// Every dictionary/set key goes through `ExplorerPaths.key(_:)` — one
/// normalizer for the cache, the expansion set, persistence, and refresh, so a
/// trailing slash or a `.` component can never split one directory into two
/// entries.
@MainActor @Observable
final class ExplorerTreeStore {
    /// Directory key (`ExplorerPaths.key`) → that directory's children. A
    /// MISSING key means "never loaded"; an EMPTY array means "loaded, and it
    /// really is empty" — the two must stay distinguishable or an empty
    /// folder would be re-enumerated on every render.
    private(set) var children: [String: [FileSystemTree.Node]] = [:]

    /// Keys of the directories the user has expanded.
    var expanded: Set<String> = []

    /// Selected rows. A `Set<URL>` because `List(selection:)` requires a set
    /// of the row `ID` type, and `ExplorerTreeStore.Row.ID` is `URL`.
    var selection: Set<URL> = []

    // MARK: - Cache reads (pure — safe to call from `body`)

    /// Cached children of `dir`, or `[]` when it has not been loaded. Never
    /// touches the filesystem and never mutates: this is the accessor a view
    /// body may call.
    func children(of dir: URL) -> [FileSystemTree.Node] {
        children[ExplorerPaths.key(dir)] ?? []
    }

    func isLoaded(_ dir: URL) -> Bool {
        children[ExplorerPaths.key(dir)] != nil
    }

    // MARK: - Loading

    /// Enumerate `dir` one level deep and store the result. The blocking
    /// `FileManager` walk runs off the main actor (`Task.detached`) so a slow
    /// directory can't stall the UI — the reason this is `async` and
    /// `children(of:)` is not.
    ///
    /// Re-loading an already-loaded directory is intentional and cheap: it is
    /// how `invalidate` + reload and the file watcher refresh a folder.
    func loadChildren(of dir: URL) async {
        let nodes = await Task.detached(priority: .userInitiated) {
            FileSystemTree.children(of: dir)
        }.value
        children[ExplorerPaths.key(dir)] = nodes
    }

    /// Forget `dir`'s children so the next `loadChildren(of:)` re-enumerates.
    func invalidate(_ dir: URL) {
        children.removeValue(forKey: ExplorerPaths.key(dir))
    }

    /// Drop every piece of per-workspace state. Called when the active project
    /// changes, so one project's tree, expansion, and selection can never leak
    /// into the next (and the cache can't grow unbounded across switches).
    func reset() {
        children.removeAll()
        expanded.removeAll()
        selection.removeAll()
    }

    // MARK: - Expansion

    /// Expand `dir`, loading its children first if needed.
    func expand(_ dir: URL) async {
        if !isLoaded(dir) { await loadChildren(of: dir) }
        expanded.insert(ExplorerPaths.key(dir))
    }

    /// Collapse `dir`. The children stay cached — re-expanding is then
    /// instant, and a collapsed folder's cache is still what `refreshLoaded`
    /// keeps current.
    func collapse(_ dir: URL) {
        expanded.remove(ExplorerPaths.key(dir))
    }

    func toggle(_ dir: URL) async {
        if expanded.contains(ExplorerPaths.key(dir)) {
            collapse(dir)
        } else {
            await expand(dir)
        }
    }

    func collapseAll() {
        expanded.removeAll()
    }

    // MARK: - Display root

    /// Where the tree should actually start rendering.
    ///
    /// When the workspace root's only child is a single folder — the common
    /// single-repo case, where the root is the project's `code/` container and
    /// its one child is the cloned repo — display AT that folder instead of
    /// wrapping it in an extra collapsible row, mirroring VS Code opening a
    /// folder directly. A multi-repo project (2+ children) keeps each repo as
    /// its own top-level row.
    ///
    /// Pure by contract: it reads only already-cached children, so calling it
    /// from a view body cannot trigger filesystem work. Before `root` has been
    /// loaded it simply answers `root`, and the caller re-renders with the
    /// real answer once the load lands.
    func displayRoot(for root: URL) -> URL {
        let kids = children(of: root)
        if kids.count == 1, kids[0].isDirectory { return kids[0].url }
        return root
    }

    // MARK: - Flattening

    /// One rendered line of the tree. `id` is the `URL` so
    /// `List(selection: Set<URL>)` selects rows directly, with no separate
    /// id-to-url lookup table to keep in sync.
    struct Row: Identifiable, Hashable {
        let url: URL
        let name: String
        let isDirectory: Bool
        /// Indent level; 0 for a top-level row under `displayRoot`.
        let depth: Int
        var id: URL { url }
    }

    /// The currently VISIBLE tree, depth-first, as a flat array — the exact
    /// shape `List` wants.
    ///
    /// Recursion is bounded by `expanded`: a collapsed folder contributes one
    /// row and stops, and an expanded-but-not-yet-loaded folder also
    /// contributes one row (its children arrive on the next render after
    /// `loadChildren` completes). So this walks only what is on screen, never
    /// the whole filesystem.
    ///
    /// Pure, like the other `body`-safe accessors — it reads the cache and the
    /// expansion set and writes neither. That matters twice over: it runs on
    /// EVERY render, and every `Row.id` it emits is a `URL` copied straight
    /// out of the cached `FileSystemTree.Node`. Since expand/collapse touch
    /// only `expanded`, a surviving row's id is byte-identical across the
    /// cycle, so `List(selection:)` keeps the user's selection and animations
    /// don't tear.
    func flatten(from displayRoot: URL) -> [Row] {
        var rows: [Row] = []
        appendRows(of: displayRoot, depth: 0, into: &rows)
        return rows
    }

    private func appendRows(of dir: URL, depth: Int, into rows: inout [Row]) {
        for node in children(of: dir) {
            rows.append(Row(url: node.url, name: node.name,
                            isDirectory: node.isDirectory, depth: depth))
            guard node.isDirectory,
                  expanded.contains(ExplorerPaths.key(node.url)) else { continue }
            appendRows(of: node.url, depth: depth + 1, into: &rows)
        }
    }
}
