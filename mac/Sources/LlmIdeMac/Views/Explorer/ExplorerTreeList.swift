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
    var cut: ([URL]) -> Void
    var copy: ([URL]) -> Void
    /// Paste into this directory.
    var paste: (URL) -> Void
    /// Whether the clipboard currently holds anything — gates the menu item.
    ///
    /// A stored `Bool`, NOT a `() -> Bool`: `ExplorerView` recomputes this
    /// bundle inside `body`, so reading the clipboard THERE registers the
    /// observation dependency that re-renders the tree when the clipboard
    /// changes. Behind a closure the read would happen only when the closure
    /// runs — inside an already-built menu, outside that tracking — and the
    /// Paste item would stay stale until something else redrew the view.
    var canPaste: Bool
    /// Apply an inline rename. The `String` is the edited NAME only (never a
    /// path); the view never touches the filesystem itself.
    var commitRename: (URL, String) -> Void
    var cancelRename: () -> Void
    /// Write paths to the SYSTEM pasteboard — deliberately unlike cut/copy,
    /// which stay in `ExplorerClipboard` because they are a pending file
    /// OPERATION, not text. Copy Path exists precisely so a path can be pasted
    /// into a terminal, a chat message or another editor. `relative` selects
    /// display-root-relative paths over absolute ones.
    var copyPath: (_ urls: [URL], _ relative: Bool) -> Void
    /// Switch to Search, scoped to this folder.
    var findInFolder: (URL) -> Void
    /// Whether this folder is reachable from SEARCH's root. Search and the
    /// Explorer tree resolve their roots differently (design §3 finding #10,
    /// assigned to P4), so a folder can legitimately sit outside Search's
    /// reach — in which case the menu item is DISABLED rather than silently
    /// running a search that returns nothing.
    var canFindIn: (URL) -> Bool
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
    /// The row currently being renamed inline, if any. Owned by `ExplorerView`
    /// so a project switch or a delete can clear it — a rename editor must
    /// never outlive the row it is editing.
    var renamingURL: URL?
    @Binding var renameText: String

    /// `List` needs a `Binding`; `store` is an `@Observable` reference type
    /// held as a plain `let`, so the binding is written out rather than
    /// obtained from `@Bindable`. Same idiom as `FileTreePanel.treeList`.
    private var selectionBinding: Binding<Set<URL>> {
        Binding(get: { store.selection }, set: { store.selection = $0 })
    }

    var body: some View {
        // Resolved ONCE, here — not inside the row closure. It is O(rows), and
        // every row needs the same answer, so computing it per row would make
        // a render O(rows²) (4 M comparisons at the 2000-row case `flatten` is
        // budgeted against).
        let ordered = selectedInDisplayOrder
        return List(rows, selection: selectionBinding) { row in
            ExplorerTreeRow(row: row, store: store, gitRoot: gitRoot, git: git, actions: actions,
                            selectedInDisplayOrder: ordered,
                            renamingURL: renamingURL, renameText: $renameText)
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
            // While a row is being renamed the keyboard belongs to its
            // TextField, and this List-level handler must not compete for it.
            // If it won, ⏎ would resolve to `.open` on the row's OLD url and
            // the rename would never commit, ←/→ would collapse the tree
            // instead of moving the caret, and ⌘X/⌘C would cut the file rather
            // than the selected text.
            guard renamingURL == nil else { return .ignored }
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

    /// The selection in display order — `Set` iteration order is not stable,
    /// and a cut/copy of several rows should keep the order the user sees.
    /// Resolved through `rows` (the already-flattened visible tree) rather
    /// than a second `store.flatten` call, which costs ~3.75 ms at 2000 rows.
    private var selectedInDisplayOrder: [URL] {
        let selected = store.selection
        guard !selected.isEmpty else { return [] }
        return rows.map(\.url).filter { selected.contains($0) }
    }

    private func handle(_ command: ExplorerKeyCommand) {
        // Clipboard commands are valid with NO selection: paste lands in the
        // display root. So they are resolved before the focused-row guard.
        switch command {
        case .cut:
            actions.cut(selectedInDisplayOrder)
            return
        case .copy:
            actions.copy(selectedInDisplayOrder)
            return
        case .paste:
            actions.paste(focusedRow.map(\.enclosingDir) ?? displayRoot)
            return
        case .expand, .collapse, .open, .rename:
            break
        }
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
        case .cut, .copy, .paste:
            break   // handled above, before the focused-row guard
        }
    }
}

private extension ExplorerTreeStore.Row {
    /// The directory this row ACTS ON: itself when it is a folder, its parent
    /// when it is a file. Finder's and VS Code's rule — a file is never a
    /// container. One definition shared by New File / New Folder, the row's
    /// drop target, and paste, so the three cannot drift apart.
    var enclosingDir: URL { isDirectory ? url : url.deletingLastPathComponent() }
}

/// One row: either the shared `TreeRowLabel` — carrying this tree's click,
/// drag, drop and context menu — or, while the row is being renamed, an inline
/// text field.
///
/// Written as two explicit branches rather than one modifier chain with an `if`
/// inside it: every interaction modifier belongs to the LABEL. A `.draggable`
/// or a click-to-open gesture left on a shared parent would sit on top of the
/// text field and swallow the clicks that place the caret.
private struct ExplorerTreeRow: View {
    let row: ExplorerTreeStore.Row
    let store: ExplorerTreeStore
    let gitRoot: URL?
    let git: GitTruthStore
    let actions: ExplorerActions
    /// The whole selection in DISPLAY order, resolved once by the list. Handed
    /// down rather than recomputed here — see `targets`.
    let selectedInDisplayOrder: [URL]
    let renamingURL: URL?
    @Binding var renameText: String

    @FocusState private var renameFocused: Bool

    var body: some View {
        if renamingURL == row.url {
            renameField
        } else {
            label
        }
    }

    // MARK: - Rename branch

    private var renameField: some View {
        HStack(spacing: 0) {
            Spacer().frame(width: nameIndent)
            TextField("", text: $renameText)
                .textFieldStyle(.plain)
                .font(Typography.filename)
                .focused($renameFocused)
                .onSubmit { actions.commitRename(row.url, renameText) }
                // Esc. `onExitCommand` is AppKit's cancel hook; a
                // `.keyboardShortcut(.escape)` would not fire while a text
                // field owns the keyboard.
                .onExitCommand { actions.cancelRename() }
                .onAppear { renameFocused = true }
                .accessibilityLabel("Rename \(row.name)")
        }
        .padding(.vertical, 2)
    }

    /// Where the name text starts inside `TreeRowLabel`, so the field opens
    /// exactly over the name it replaces.
    ///
    /// Derived from that view's own layout (an `HStack(spacing: 4)`): `depth`
    /// indent guides of 14pt each, then a 10pt chevron — or, on a file row,
    /// the 10pt spacer that stands in for one — then a 16pt icon, with one
    /// 4pt gap before each. At depth 0 `indentGuides` renders nothing at all
    /// rather than a zero-width view, so its own gap disappears with it.
    private var nameIndent: CGFloat {
        let guides = row.depth > 0 ? CGFloat(row.depth) * 14 + 4 : 0
        return guides + 10 + 4 + 16 + 4
    }

    // MARK: - Normal branch

    private var label: some View {
        let decoration = gitRoot.flatMap {
            git.decoration(forAbsolute: row.url, root: $0, isDirectory: row.isDirectory)
        }
        return TreeRowLabel(
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
        // VS Code opens a file on single click. This is a
        // `simultaneousGesture`, not an `onTapGesture`: a plain tap gesture
        // CONSUMES the click, and `List` would never see it — losing selection,
        // ⌘-toggle and ⇧-range in one go. Opening used to hang off
        // `onChange(of: store.selection)` instead, which meant arrowing down
        // through N files opened N permanent tabs; selection movement and
        // opening are separate acts now.
        .simultaneousGesture(TapGesture().onEnded {
            // Folders are toggled by their own chevron button, never opened.
            guard !row.isDirectory else { return }
            // ⌘/⇧ clicks are multi-select gestures — extending a selection is
            // not a request to open anything. Read from `NSEvent` because
            // `TapGesture` carries no modifiers; same source the ⌥-copy drop
            // below reads.
            let flags = NSEvent.modifierFlags
            guard !flags.contains(.command), !flags.contains(.shift) else { return }
            actions.open(row.url)
        })
        // `targets` is already exactly the right drag set: the whole selection
        // when the dragged row is part of it, otherwise just that row. One
        // `String` carries all of them — see `ExplorerDragPayload`.
        .draggable(ExplorerDragPayload.encode(targets))
        .dropDestination(for: String.self) { items, _ in
            let sources = items.flatMap { ExplorerDragPayload.decode($0) }
            guard !sources.isEmpty else { return false }
            // Dropping on a FILE targets the folder it lives in, matching
            // Finder and VS Code — a file is never itself a container.
            actions.drop(sources, row.enclosingDir, NSEvent.modifierFlags.contains(.option))
            return true
        }
        .contextMenu { contextMenuItems }
    }

    /// Right-clicking a row that is part of the current selection acts on the
    /// WHOLE selection; right-clicking outside it acts on just that row. Same
    /// rule the Source Control changes list uses, so the two panels behave
    /// identically. (SwiftUI's `List` does not select on right-click, which is
    /// why this has to be resolved explicitly.)
    ///
    /// The multi-row answer is `selectedInDisplayOrder`, never
    /// `Array(store.selection)`: a `Set`'s iteration order is arbitrary and
    /// changes with its contents, so the same four selected rows came out as
    /// `b, d, c, a`. That order is USER-VISIBLE — it is the order a drag and a
    /// context-menu cut/copy apply their operations in, and therefore which
    /// item a partial failure stops at — so it has to be the order on screen,
    /// the same one the keyboard path already used.
    private var targets: [URL] {
        store.selection.contains(row.url) ? selectedInDisplayOrder : [row.url]
    }

    @ViewBuilder
    private var contextMenuItems: some View {
        Button("New File") { actions.newFile(row.enclosingDir) }
        Button("New Folder") { actions.newFolder(row.enclosingDir) }
        Divider()
        Button(targets.count > 1 ? "Cut \(targets.count) Items" : "Cut") { actions.cut(targets) }
        Button(targets.count > 1 ? "Copy \(targets.count) Items" : "Copy") { actions.copy(targets) }
        Button("Paste") { actions.paste(row.enclosingDir) }
            .disabled(!actions.canPaste)
        Divider()
        Button("Rename") { actions.beginRename(row.url) }
        Button(targets.count > 1 ? "Delete \(targets.count) Items" : "Delete",
               role: .destructive) { actions.delete(targets) }
        Divider()
        Button("Copy Path") { actions.copyPath(targets, false) }
        Button("Copy Relative Path") { actions.copyPath(targets, true) }
        // Folders only — "Find in this file" is not a thing, and unlike the
        // items above this one acts on the clicked ROW, never the selection:
        // Search takes exactly one scope.
        if row.isDirectory {
            Button("Find in Folder") { actions.findInFolder(row.url) }
                .disabled(!actions.canFindIn(row.url))
        }
        Divider()
        Button("Reveal in Finder") { actions.revealInFinder(targets) }
    }
}
