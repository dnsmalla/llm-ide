import SwiftUI
import AppKit

/// Everything the Explorer tree can DO, injected as closures.
///
/// The list and its rows stay presentation-only: they never touch the
/// filesystem, never present a sheet, and never own tab state — all of that
/// belongs to `ExplorerView`, which builds this bundle. That is what keeps the
/// tree renderable in isolation and keeps destructive work in one auditable
/// place.
struct ExplorerActions {
    var open: (URL) -> Void
    var newFile: (URL) -> Void
    var newFolder: (URL) -> Void
    var beginRename: (URL) -> Void
    var delete: ([URL]) -> Void
    var revealInFinder: ([URL]) -> Void
    /// Drag & drop landing. `copy` is true when ⌥ was held (Finder's
    /// convention); otherwise the sources are moved.
    var drop: (_ sources: [URL], _ destinationDir: URL, _ copy: Bool) -> Void
}

/// The file tree, as a real `List` with a `Set<URL>` selection.
///
/// Replaces the previous `ScrollView` + `LazyVStack` + per-row `Button`, which
/// could not do multi-select, had no keyboard navigation, and highlighted only
/// the label's own width instead of the full row. `List(selection:)` gives all
/// three for free — plus ⌘-click toggle and ⇧-click range — because it is the
/// same control the rest of macOS uses.
///
/// Rows come from `ExplorerTreeStore.flatten(from:)` as a FLAT array whose
/// element `ID` is the row's `URL`, which is what lets `selection` be a plain
/// `Set<URL>` with no id↔url lookup table to keep in sync. Indentation is the
/// row's `depth`, rendered by `TreeRowLabel`'s existing indent guides.
///
/// `rows` is passed IN rather than flattened here: `flatten` costs ~3.75 ms at
/// 2000 rows against a 16.6 ms frame budget, and `ExplorerView`'s toolbar needs
/// the same visible rows to resolve its create-target. Flattening once in
/// `ExplorerView.treePane` and handing the result to both keeps that off the
/// render path twice over.
struct ExplorerTreeList: View {
    let rows: [ExplorerTreeStore.Row]
    let store: ExplorerTreeStore
    let displayRoot: URL
    /// The git WORKING TREE (not the tree root) — see `ExplorerView.gitRoot`.
    let gitRoot: URL?
    let git: GitTruthStore
    let actions: ExplorerActions

    /// `List` needs a `Binding`; `store` is an `@Observable` reference type
    /// held as a plain `let`, so the binding is written out rather than
    /// obtained from `@Bindable`. Same idiom as `FileTreePanel.treeList`.
    private var selectionBinding: Binding<Set<URL>> {
        Binding(get: { store.selection }, set: { store.selection = $0 })
    }

    var body: some View {
        List(rows, selection: selectionBinding) { row in
            ExplorerTreeRow(row: row, store: store, gitRoot: gitRoot, git: git, actions: actions)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
        }
        .listStyle(.sidebar)
        // The empty space below the last row is a drop target for the tree
        // root, so dragging to the bottom of the list moves an item OUT of
        // whatever folder it is in — the only way to reach the root when the
        // root itself has no row of its own (the single-repo display case).
        // Row destinations are nested inside this one and win the hit test.
        .dropDestination(for: String.self) { items, _ in
            let sources = items.flatMap { ExplorerDragPayload.decode($0) }
            guard !sources.isEmpty else { return false }
            actions.drop(sources, displayRoot, NSEvent.modifierFlags.contains(.option))
            return true
        }
        .onKeyPress(phases: .down) { press in
            guard let command = ExplorerKeyCommand.resolve(
                character: press.key.character,
                command: press.modifiers.contains(.command)) else { return .ignored }
            handle(command)
            return .handled
        }
    }

    /// The row keyboard commands act on: the FIRST selected row in display
    /// order. Resolving through `rows` rather than `selection.first` keeps this
    /// deterministic — `Set` iteration order is not.
    private var focusedRow: ExplorerTreeStore.Row? {
        let selected = store.selection
        guard !selected.isEmpty else { return nil }
        return rows.first { selected.contains($0.url) }
    }

    private func handle(_ command: ExplorerKeyCommand) {
        guard let row = focusedRow else { return }
        switch command {
        case .expand:
            guard row.isDirectory else { return }
            Task { await store.expand(row.url) }
        case .collapse:
            if row.isDirectory, store.expanded.contains(ExplorerPaths.key(row.url)) {
                store.collapse(row.url)
            } else {
                // VS Code: ← on a leaf (or an already-collapsed folder) walks
                // up to the parent and collapses it — but never past the
                // display root, which has no row of its own.
                let parent = row.url.deletingLastPathComponent()
                guard ExplorerPaths.isDescendant(parent, of: displayRoot) else { return }
                store.selection = [parent]
                store.collapse(parent)
            }
        case .open:
            if row.isDirectory {
                Task { await store.toggle(row.url) }
            } else {
                actions.open(row.url)
            }
        case .rename:
            actions.beginRename(row.url)
        }
    }
}

/// One row: the shared `TreeRowLabel` plus this tree's context menu.
private struct ExplorerTreeRow: View {
    let row: ExplorerTreeStore.Row
    let store: ExplorerTreeStore
    let gitRoot: URL?
    let git: GitTruthStore
    let actions: ExplorerActions

    var body: some View {
        let decoration = gitRoot.flatMap {
            git.decoration(forAbsolute: row.url, root: $0, isDirectory: row.isDirectory)
        }
        TreeRowLabel(
            name: row.name,
            isFolder: row.isDirectory,
            isExpanded: store.expanded.contains(ExplorerPaths.key(row.url)),
            depth: row.depth,
            isSelected: store.selection.contains(row.url),
            fileExtension: row.isDirectory ? "" : row.url.pathExtension.lowercased(),
            gitStatus: decoration,
            onToggleChevron: row.isDirectory ? { Task { await store.toggle(row.url) } } : nil
        )
        .help(row.name)
        // `targets` is already exactly the right drag set: the whole selection
        // when the dragged row is part of it, otherwise just that row. One
        // `String` carries all of them — see `ExplorerDragPayload`.
        .draggable(ExplorerDragPayload.encode(targets))
        .dropDestination(for: String.self) { items, _ in
            let sources = items.flatMap { ExplorerDragPayload.decode($0) }
            guard !sources.isEmpty else { return false }
            // Dropping on a FILE targets the folder it lives in, matching
            // Finder and VS Code — a file is never itself a container.
            actions.drop(sources, enclosingDir, NSEvent.modifierFlags.contains(.option))
            return true
        }
        .contextMenu { contextMenuItems }
    }

    /// Right-clicking a row that is part of the current selection acts on the
    /// WHOLE selection; right-clicking outside it acts on just that row. Same
    /// rule the Source Control changes list uses, so the two panels behave
    /// identically. (SwiftUI's `List` does not select on right-click, which is
    /// why this has to be resolved explicitly.)
    private var targets: [URL] {
        store.selection.contains(row.url) ? Array(store.selection) : [row.url]
    }

    /// Where "New File"/"New Folder" create: inside a folder row, alongside a
    /// file row.
    private var enclosingDir: URL {
        row.isDirectory ? row.url : row.url.deletingLastPathComponent()
    }

    @ViewBuilder
    private var contextMenuItems: some View {
        Button("New File") { actions.newFile(enclosingDir) }
        Button("New Folder") { actions.newFolder(enclosingDir) }
        Button("Rename") { actions.beginRename(row.url) }
        Button(targets.count > 1 ? "Delete \(targets.count) Items" : "Delete",
               role: .destructive) { actions.delete(targets) }
        Divider()
        Button("Reveal in Finder") { actions.revealInFinder(targets) }
    }
}
