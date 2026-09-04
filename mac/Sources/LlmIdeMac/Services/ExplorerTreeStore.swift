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
    ///
    /// Invariant: every member is a row the tree can currently render. SwiftUI
    /// does NOT drop selection ids whose rows disappear, so the store prunes
    /// on every event that hides a row (`collapse`, `collapseAll`) or destroys
    /// one (`refreshLoaded`). Without that, `persistState` would save rows the
    /// user can no longer see, and a bulk delete would act on invisible files.
    var selection: Set<URL> = []

    /// Monotonic ticket source for `loadChildren`. NEVER reset, so a ticket
    /// value can never be reused and `pendingLoads` can be cleared wholesale
    /// without an ABA hazard.
    private var loadTicket = 0

    /// Directory key → ticket of the newest `loadChildren` started for it.
    /// A load whose ticket is no longer the entry here has been superseded and
    /// must throw its result away. See `loadChildren`.
    private var pendingLoads: [String: Int] = [:]

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
    ///
    /// **Newest-load-wins.** There is a suspension point between reading the
    /// directory and writing the cache, so two loads of the same directory can
    /// overlap and the plain version resolved that by completion order — the
    /// wrong order. Each load takes a ticket before suspending and drops its
    /// result if a newer load for the same directory has started since. That
    /// closes three things at once: a slow user-initiated expand can no longer
    /// land stale children over a newer watcher refresh; `reset()` can no
    /// longer be undone by a load that was already in flight (`Task.detached`
    /// is deliberately non-cancellable, so cancelling the caller's task does
    /// not stop it); and `refreshLoaded` can drop a vanished directory without
    /// an in-flight load resurrecting it.
    ///
    /// Each child URL is standardized as it ENTERS the store. `FileManager`
    /// hands back symlink-resolved URLs (`/private/var/…`) that are neither
    /// `==` nor hash-equal to the same file spelled `/var/…`, and
    /// `List(selection:)` matches rows by raw `URL` hashing — so without this
    /// a restored or revealed selection built by joining a root with a
    /// relative path would silently fail to select. Standardizing here is the
    /// half that makes `ExplorerPaths.canonical(_:)` work at the other
    /// boundary: it also gives the store the invariant `row.url.path ==
    /// ExplorerPaths.key(row.url)`. It resolves no symlink of its own, so a
    /// symlinked entry keeps its own name rather than its target's.
    func loadChildren(of dir: URL) async {
        let key = ExplorerPaths.key(dir)
        loadTicket += 1
        let ticket = loadTicket
        pendingLoads[key] = ticket
        let nodes = await Task.detached(priority: .userInitiated) {
            FileSystemTree.children(of: dir).map {
                FileSystemTree.Node(url: $0.url.standardizedFileURL,
                                    name: $0.name, isDirectory: $0.isDirectory)
            }
        }.value
        guard pendingLoads[key] == ticket else { return }   // superseded
        pendingLoads.removeValue(forKey: key)
        children[key] = nodes
    }

    /// Forget `dir`'s children so the next `loadChildren(of:)` re-enumerates.
    ///
    /// Deliberately leaves `pendingLoads` and `selection` alone: this is the
    /// "reload me" primitive, the rows come straight back, and dropping the
    /// user's selection on a manual refresh would be a regression. The paths
    /// that genuinely destroy rows (`collapse`, `refreshLoaded`) prune.
    func invalidate(_ dir: URL) {
        children.removeValue(forKey: ExplorerPaths.key(dir))
    }

    /// Drop every piece of per-workspace state. Called when the active project
    /// changes, so one project's tree, expansion, and selection can never leak
    /// into the next (and the cache can't grow unbounded across switches).
    ///
    /// Clearing `pendingLoads` is what makes this stick: an in-flight load
    /// started before the switch finds its ticket gone and discards its
    /// result, instead of repopulating the old project's children afterwards.
    func reset() {
        children.removeAll()
        expanded.removeAll()
        selection.removeAll()
        pendingLoads.removeAll()
        // The watcher is per-workspace state too: a live watcher on the old
        // root would keep refreshing a tree that is no longer on screen.
        stopWatching()
    }

    // MARK: - Expansion

    /// Expand `dir`, loading its children first if needed.
    ///
    /// The insert happens BEFORE the `await`, not after: `toggle` decides what
    /// to do by reading `expanded`, so leaving the set unchanged across the
    /// load's suspension point let two quick toggles both read "collapsed" and
    /// net to expanded. The folder rendering open-and-empty for one frame
    /// while its children load is a case `flatten` already handles.
    func expand(_ dir: URL) async {
        expanded.insert(ExplorerPaths.key(dir))
        if !isLoaded(dir) { await loadChildren(of: dir) }
    }

    /// Collapse `dir`. The children stay cached — re-expanding is then
    /// instant, and a collapsed folder's cache is still what `refreshLoaded`
    /// keeps current. The selection does NOT stay: rows under `dir` are no
    /// longer rendered, and SwiftUI keeps un-rendered ids in the selection set
    /// forever.
    func collapse(_ dir: URL) {
        expanded.remove(ExplorerPaths.key(dir))
        pruneSelection(under: dir)
    }

    func toggle(_ dir: URL) async {
        let key = ExplorerPaths.key(dir)
        if expanded.contains(key) {
            collapse(dir)
        } else {
            // Synchronous insert first, so nothing can observe "collapsed"
            // between the check and the act. `expand` re-inserts idempotently.
            expanded.insert(key)
            await expand(dir)
        }
    }

    /// Collapse everything. Selection is cleared rather than filtered: after
    /// this only rows directly under the display root are still rendered, and
    /// the store does not know the display root (the caller does). Clearing is
    /// the conservative choice — an invisible survivor would be persisted and
    /// would become a silent target for a later bulk delete.
    func collapseAll() {
        expanded.removeAll()
        selection.removeAll()
    }

    /// Drop every selected row that lives strictly under `dir`. Strict, via
    /// `ExplorerPaths.isDescendant`, so collapsing a folder never deselects
    /// the folder itself — its own row is still on screen.
    private func pruneSelection(under dir: URL) {
        guard !selection.isEmpty else { return }
        selection = selection.filter { !ExplorerPaths.isDescendant($0, of: dir) }
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

    // MARK: - Persistence

    /// On-disk shape. Both arrays hold ROOT-RELATIVE paths (see
    /// `persistState`), so the same state restores after the project folder
    /// moves or is re-cloned to a different absolute path.
    private struct PersistedState: Codable {
        var expanded: [String]
        var selection: [String]
    }

    /// `UserDefaults` key for one workspace root, so switching projects
    /// switches state instead of merging two trees into one.
    ///
    /// Keyed off `ExplorerPaths.canonical(root)`, not `root` as given: the
    /// same workspace reached as `/tmp/p` and `/private/tmp/p` must resolve to
    /// ONE key, or a save under one spelling would be invisible to a restore
    /// under the other.
    static func defaultsKey(for root: URL) -> String {
        "EXPLORER_TREE_STATE::" + ExplorerPaths.key(ExplorerPaths.canonical(root))
    }

    /// Save expansion + selection for `root`. Anything outside `root` is
    /// skipped rather than stored absolutely — a half-relative, half-absolute
    /// blob would restore inconsistently after a move.
    func persistState(for root: URL, defaults: UserDefaults = .standard) {
        let base = ExplorerPaths.canonical(root)
        let expandedRel = expanded.compactMap { key -> String? in
            let rel = ExplorerPaths.relativePath(of: URL(fileURLWithPath: key), from: base)
            return (rel?.isEmpty == false) ? rel : nil
        }
        let selectionRel = selection.compactMap { url -> String? in
            let rel = ExplorerPaths.relativePath(of: url, from: base)
            return (rel?.isEmpty == false) ? rel : nil
        }
        let state = PersistedState(expanded: expandedRel.sorted(), selection: selectionRel.sorted())
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.defaultsKey(for: root))
    }

    /// Restore expansion + selection for `root`, dropping any entry whose file
    /// no longer exists (a deleted folder must not come back as a phantom
    /// expanded row), and LOADING the children of every restored expanded
    /// folder so the tree renders fully populated on first paint.
    ///
    /// A missing/corrupt blob is not an error: the tree simply starts
    /// collapsed, which is the same as a first run.
    ///
    /// **Why `ExplorerPaths.canonical(root)` and not `root`.** Restored URLs
    /// are rebuilt by joining, and a joined URL keeps whatever spelling the
    /// caller's root had, while every row's URL came out of `FileManager` (and
    /// through `loadChildren`'s standardization). `List(selection:)` matches
    /// by raw `URL` hashing, so a selection restored under the other spelling
    /// decodes perfectly and then selects nothing at all. Canonicalizing the
    /// root once — a boundary crossing, and the only filesystem-touching call
    /// in `ExplorerPaths` — puts both halves in the same spelling. Verified by
    /// probe over a real tree: `canonical(root) + rel` is `==` AND hash-equal
    /// to the row for files, directories, symlinked entries, spaces and
    /// non-ASCII names, whichever way the caller spells the root.
    func restoreState(for root: URL, defaults: UserDefaults = .standard) async {
        guard let data = defaults.data(forKey: Self.defaultsKey(for: root)),
              let state = try? JSONDecoder().decode(PersistedState.self, from: data) else { return }

        let base = ExplorerPaths.canonical(root)
        let fm = FileManager.default
        var restoredDirs: [URL] = []
        for rel in state.expanded {
            let url = base.appendingPathComponent(rel)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { continue }
            restoredDirs.append(url)
        }
        // Shallowest first, so a parent is loaded before its child is expanded.
        restoredDirs.sort { $0.pathComponents.count < $1.pathComponents.count }
        for dir in restoredDirs { await expand(dir) }

        selection = Set(state.selection.compactMap { rel -> URL? in
            let url = base.appendingPathComponent(rel)
            return fm.fileExists(atPath: url.path) ? url : nil
        })
    }

    // MARK: - Live filesystem updates

    /// Re-enumerate every directory currently in the cache, and forget the
    /// ones that no longer exist (also pruning them from `expanded`, and
    /// pruning vanished files from `selection`).
    ///
    /// Deliberately does NOT load directories that were never opened: the
    /// tree's whole cost model is "one level at a time", and walking unopened
    /// folders on every filesystem event would undo that.
    ///
    /// Row identity survives this. Every `Row.id` is the `URL` out of the
    /// cached node, and a reload rebuilds those URLs through exactly the same
    /// path `loadChildren` used the first time — `FileManager` resolves the
    /// children of a directory the same way regardless of how the parent was
    /// spelled, and the standardization on top is deterministic. So a file
    /// that did not change keeps a byte-identical id across the refresh, and
    /// `List(selection:)` neither loses the selection nor tears its animations.
    ///
    /// The cache is re-keyed off the STORED key strings, never re-derived from
    /// a URL of a deleted file: `standardizedFileURL`'s `/private` fold is
    /// existence-dependent, so a path that vanished would key differently than
    /// it did while it existed and the entry would leak.
    func refreshLoaded() async {
        let fm = FileManager.default
        for key in Array(children.keys) {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: key, isDirectory: &isDir), isDir.boolValue else {
                children.removeValue(forKey: key)
                expanded.remove(key)
                // Drop any in-flight load too, or it would resurrect the
                // directory as a "loaded, empty" entry when it lands.
                pendingLoads.removeValue(forKey: key)
                continue
            }
            await loadChildren(of: URL(fileURLWithPath: key))
        }
        selection = selection.filter { fm.fileExists(atPath: $0.path) }
    }

    private var watcher: RepoFileWatcher?

    /// Start live-refreshing the loaded part of the tree on filesystem changes
    /// under `root`.
    ///
    /// The debounce is **1.0s**, deliberately shorter than
    /// `GitTruthStore.startWatching`'s 2.0s: a file appearing in the tree
    /// should feel immediate, while a git-status recomputation (which shells
    /// out) can afford to coalesce longer. The two watchers are separate on
    /// purpose — this one is rooted at the TREE root (often a `code/`
    /// container holding several clones), which is frequently not the git
    /// working tree at all, and refreshing git status would not re-enumerate
    /// any directory anyway.
    ///
    /// No feedback loop: `refreshLoaded` only reads the filesystem, so a
    /// refresh cannot retrigger the watcher that caused it.
    ///
    /// Safe to call repeatedly: it replaces any existing watcher.
    /// `RepoFileWatcher.init?` returns nil if FSEvents can't start (rare); in
    /// that case this is a silent no-op and the toolbar's manual Refresh stays
    /// the fallback.
    func startWatching(_ root: URL) {
        stopWatching()
        watcher = RepoFileWatcher(repoRoot: root, debounce: 1.0) { [weak self] in
            // Fires on the watcher's own background queue — hop to the main
            // actor before touching `self`.
            Task { @MainActor in
                await self?.refreshLoaded()
            }
        }
    }

    func stopWatching() {
        watcher?.stop()
        watcher = nil
    }
}
