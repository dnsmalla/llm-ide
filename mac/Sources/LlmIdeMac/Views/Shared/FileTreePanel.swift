import SwiftUI

// MARK: - Tree node model

struct FSNode: Identifiable {
    let id: String          // absolute path (unique key)
    let name: String
    let url: URL
    let item: LibraryItem?  // non-nil for file leaves
    var children: [FSNode]

    var isFile: Bool { item != nil }

    /// Recursively sort: folders first (alpha), then files (alpha).
    func sorted() -> FSNode {
        var copy = self
        copy.children = children
            .map { $0.sorted() }
            .sorted {
                if $0.isFile != $1.isFile { return !$0.isFile }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        return copy
    }
}

// MARK: - Tree builder

/// Build an FSNode tree from a flat list of LibraryItems rooted at
/// `root`. Internal (not private) so other views — e.g. the
/// Regression Sources pane — can drive the same shape of tree from
/// the same LibraryItemStore items the Library tab renders.
///
/// `displayName` overrides the root node's user-visible label —
/// pass `folderOrigin` so the tree shows "InfiniteBrain" even when
/// items span across siblings and the computed common ancestor
/// widens to `/Users/<you>`.
func buildTree(items: [LibraryItem], root: URL, displayName: String? = nil) -> FSNode {
    let name = displayName ?? root.lastPathComponent
    var rootNode = FSNode(id: root.path, name: name, url: root, item: nil, children: [])
    for item in items {
        let parts = item.url.pathComponents
        let base  = root.pathComponents
        guard parts.count > base.count,
              Array(parts.prefix(base.count)) == base else { continue }
        let relative = Array(parts.dropFirst(base.count))
        insert(into: &rootNode, components: relative, item: item, currentURL: root)
    }
    return rootNode.sorted()
}

func insert(into node: inout FSNode, components: [String], item: LibraryItem, currentURL: URL) {
    guard let head = components.first else { return }
    let childURL = currentURL.appendingPathComponent(head)

    if components.count == 1 {
        node.children.append(FSNode(id: childURL.path, name: head, url: childURL, item: item, children: []))
    } else {
        if let idx = node.children.firstIndex(where: { $0.id == childURL.path }) {
            insert(into: &node.children[idx], components: Array(components.dropFirst()), item: item, currentURL: childURL)
        } else {
            var folder = FSNode(id: childURL.path, name: head, url: childURL, item: nil, children: [])
            insert(into: &folder, components: Array(components.dropFirst()), item: item, currentURL: childURL)
            node.children.append(folder)
        }
    }
}

/// Loose-file leaves + one folder-rooted FSNode per `folderOrigin`,
/// alpha-sorted. Lifted out of FileTreePanel so the Regression
/// Sources pane can render the same trees Library renders without
/// duplicating the grouping logic.
func buildCategoryTrees(items: [LibraryItem]) -> [FSNode] {
    let loose = items.filter { $0.folderOrigin == nil }
    let grouped = Dictionary(grouping: items.filter { $0.folderOrigin != nil },
                             by: { $0.folderOrigin! })
    var result: [FSNode] = []
    for item in loose.sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
        result.append(FSNode(id: item.path, name: item.name, url: item.url, item: item, children: []))
    }
    for folderName in grouped.keys.sorted() {
        let folderItems = grouped[folderName] ?? []
        guard !folderItems.isEmpty else { continue }
        // Compute common ancestor of parent *directories*, not file paths.
        // With a single file, commonAncestor of the file path returns the
        // file itself — buildTree then finds no relative components and
        // produces an empty folder node. Using parent dirs fixes this for
        // both single-file and multi-file groups.
        let ancestor = commonAncestor(
            folderItems.map { URL(fileURLWithPath: $0.path).deletingLastPathComponent().path }
        )
        let rootURL  = URL(fileURLWithPath: ancestor)
        // folderName is the human label (e.g. "InfiniteBrain") —
        // pass it as displayName so the tree shows that instead of
        // the computed ancestor's lastPathComponent, which can
        // widen to ~/ or your username when items aren't all
        // strictly under one folder.
        result.append(buildTree(items: folderItems, root: rootURL, displayName: folderName))
    }
    return result
}

/// Longest common path shared by all items (used to find the repo root).
func commonAncestor(_ paths: [String]) -> String {
    guard let first = paths.first else { return "" }
    let split = paths.map { $0.components(separatedBy: "/") }
    let shortest = split.min(by: { $0.count < $1.count }) ?? []
    var result: [String] = []
    for i in 0..<shortest.count {
        let c = shortest[i]
        if split.allSatisfy({ $0.indices.contains(i) && $0[i] == c }) { result.append(c) }
        else { break }
    }
    let joined = result.joined(separator: "/")
    return joined.isEmpty ? first : joined
}

// MARK: - File-extension icon + colour (delegates to shared FileIconKit)

// MARK: - Recursive row (separate struct breaks the @ViewBuilder recursion limit)

private struct FSNodeRow: View {
    let node: FSNode
    let depth: Int
    let category: LibraryItem.Category
    @Binding var expandedPaths: Set<String>
    @Binding var selectedURL: URL?
    let store: LibraryItemStore
    @State private var showDeleteConfirmation = false
    @State private var showRemoveConfirmation = false

    var body: some View {
        if node.isFile {
            fileRow
                .tag(node.url)
                .background(confirmationDialogs)
        } else {
            folderRow
            if expandedPaths.contains(node.id) {
                ForEach(node.children) { child in
                    FSNodeRow(node: child, depth: depth + 1,
                              category: category,
                              expandedPaths: $expandedPaths,
                              selectedURL: $selectedURL,
                              store: store)
                }
            }
        }
    }

    // MARK: Folder row

    private var folderRow: some View {
        let expanded = expandedPaths.contains(node.id)
        return Button {
            if expanded { expandedPaths.remove(node.id) }
            else        { expandedPaths.insert(node.id) }
        } label: {
            HStack(spacing: 4) {
                if depth > 0 { Spacer().frame(width: CGFloat(depth) * 14) }
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: expanded ? "folder.fill" : "folder")
                    .font(Typography.filename)
                    .foregroundStyle(category.folderTint)
                    .frame(width: 16)
                Text(node.name)
                    .font(Typography.filename)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }

    // MARK: File row

    private var fileRow: some View {
        let ext = URL(fileURLWithPath: node.name).pathExtension.lowercased()
        return HStack(spacing: 4) {
            Spacer().frame(width: CGFloat(depth) * 14 + 14)
            Image(systemName: FileIconKit.icon(for: ext))
                .font(.system(size: 11))
                .foregroundStyle(FileIconKit.color(for: ext))
                .frame(width: 16)
            Text(node.name)
                .font(Typography.filename)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .help(node.name)
        .contextMenu {
            if category == .meetings {
                meetingFileContextMenu
            } else {
                genericFileContextMenu
            }
        }
    }

    // MARK: Context menus

    @ViewBuilder
    private var meetingFileContextMenu: some View {
        // Primary action: generate a polished .docx note from this transcript.
        Button {
            if let item = node.item {
                NotificationCenter.default.post(
                    name: .resummarizeMeetingFile, object: item.url)
            }
        } label: {
            Label("Generate Note", systemImage: "sparkles")
        }
        Divider()
        Button {
            if let item = node.item {
                NSWorkspace.shared.activateFileViewerSelecting([item.url])
            }
        } label: {
            Label("Reveal in Finder", systemImage: "folder")
        }
        Divider()
        Button("Delete Transcript", role: .destructive) {
            showDeleteConfirmation = true
        }
    }

    @ViewBuilder
    private var genericFileContextMenu: some View {
        Button("Reveal in Finder") {
            if let item = node.item {
                NSWorkspace.shared.activateFileViewerSelecting([item.url])
            }
        }
        Divider()
        Button("Remove from Library", role: .destructive) {
            showRemoveConfirmation = true
        }
    }

    // MARK: Confirmation dialogs

    var confirmationDialogs: some View {
        EmptyView()
            .confirmationDialog("Delete \"\(node.name)\"?", isPresented: $showDeleteConfirmation) {
                Button("Delete", role: .destructive) {
                    if let item = node.item {
                        if selectedURL == node.url { selectedURL = nil }
                        try? FileManager.default.removeItem(at: item.url)
                        store.remove(id: item.id)
                        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
                    }
                }
            } message: {
                Text("This will permanently delete the transcript file from disk.")
            }
            .confirmationDialog("Remove \"\(node.name)\" from the library?", isPresented: $showRemoveConfirmation) {
                Button("Remove", role: .destructive) {
                    if let item = node.item {
                        store.remove(id: item.id)
                        if selectedURL == node.url { selectedURL = nil }
                    }
                }
            } message: {
                Text("The file will remain on disk but won't appear in the library.")
            }
    }
}

// MARK: - Panel

struct FileTreePanel: View {
    let title: String
    let categories: [LibraryItem.Category]
    @Binding var selectedURL: URL?

    /// Same environment access as LibraryView — used to sync the NOTES
    /// section directly from the notes output folder when this panel
    /// shows notes or data categories.
    @Environment(AppEnvironment.self) private var env
    @Environment(LibraryItemStore.self) private var store
    @State private var expandedPaths: Set<String> = []
    @State private var panelWidth: CGFloat = 240
    @State private var treeCache: [LibraryItem.Category: [FSNode]] = [:]
    private var isCompact: Bool { panelWidth < 150 }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            treeList
        }
        .background(.background)
        .background(GeometryReader { geo in
            Color.clear
                .onAppear { panelWidth = geo.size.width }
                .onChange(of: geo.size.width) { _, w in panelWidth = w }
        })
        .onAppear {
            syncIfNeeded()
            rebuildTreeCache()
            autoExpand()
        }
        .onChange(of: store.items.count) { _, _ in
            rebuildTreeCache()
            autoExpand()
        }
        // Mirror LibraryView: re-sync and rebuild the tree whenever
        // the meeting index changes (new note file, project switch, etc.).
        .onReceive(NotificationCenter.default.publisher(for: .meetingIndexChanged)) { _ in
            syncIfNeeded()
            rebuildTreeCache()
            autoExpand()
        }
    }

    /// Sync notes / transcripts from their folders when this panel
    /// displays those categories — mirrors AppShell's central sync.
    private func syncIfNeeded() {
        if categories.contains(.notes) {
            store.syncMeetingNotes(from: env.notesOutputFolder)
        }
        if categories.contains(.meetings) {
            store.syncMeetingTranscripts(from: env.meetingsFolder)
        }
    }

    private func rebuildTreeCache() {
        var cache: [LibraryItem.Category: [FSNode]] = [:]
        for cat in categories {
            cache[cat] = buildTrees(for: cat)
        }
        treeCache = cache
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            if !isCompact {
                SectionLabel(title)
            }
            Spacer()
        }
        .padding(.horizontal, isCompact ? 6 : 12)
        .padding(.vertical, 8)
        .background(.bar)
        .help(isCompact ? title : "")
    }

    // MARK: - Tree list

    private var treeList: some View {
        List(selection: Binding(get: { selectedURL }, set: { selectedURL = $0 })) {
            ForEach(categories, id: \.self) { cat in
                let trees = treeCache[cat] ?? []
                Section {
                    if trees.isEmpty {
                        if !isCompact {
                            Text("No \(cat.rawValue.lowercased()) files yet")
                                .font(Typography.fileMeta)
                                .foregroundStyle(.quaternary)
                                .listRowSeparator(.hidden)
                        }
                    } else {
                        ForEach(trees) { root in
                            nodeView(root, depth: 0, category: cat)
                        }
                    }
                } header: {
                    sectionHeader(for: cat)
                }
            }
        }
        .listStyle(.sidebar)
    }

    // MARK: - Recursive node view (delegates to FSNodeRow to avoid recursive @ViewBuilder)

    @ViewBuilder
    private func nodeView(_ node: FSNode, depth: Int, category: LibraryItem.Category) -> some View {
        FSNodeRow(node: node, depth: depth,
                  category: category,
                  expandedPaths: $expandedPaths,
                  selectedURL: $selectedURL,
                  store: store)
    }

    // MARK: - Section header

    @ViewBuilder
    private func sectionHeader(for category: LibraryItem.Category) -> some View {
        if isCompact {
            HStack {
                Spacer(minLength: 0)
                addControl(for: category, compactIcon: true)
                Spacer(minLength: 0)
            }
        } else {
            HStack(spacing: 0) {
                HStack(spacing: 6) {
                    Image(systemName: category.icon)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(category.uiColor)
                        .frame(width: 18, height: 18)
                        .background(category.uiColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                    Text(category.rawValue)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(category.uiColor)
                        .textCase(.uppercase)
                        .tracking(0.5)
                }
                Spacer(minLength: 4)
                addControl(for: category, compactIcon: false)
            }
        }
    }

    @ViewBuilder
    private func addControl(for category: LibraryItem.Category, compactIcon: Bool) -> some View {
        if category == .code {
            // Code repos come from GitLab Settings only — the "+" jumps
            // straight there so users can't manually import folders that
            // would then be pruned on the next config sync.
            Button {
                NotificationCenter.default.post(name: .openSettings, object: nil)
            } label: {
                addLabel(category: category, compactIcon: compactIcon)
            }
            .buttonStyle(.plain)
            .help("Add a repo in Settings → GitLab")
        } else {
            Menu {
                Button { pickFile(for: category) }   label: { Label("Add File",   systemImage: "doc.badge.plus") }
                Button { pickFolder(for: category) } label: { Label("Add Folder", systemImage: "folder.badge.plus") }
            } label: {
                addLabel(category: category, compactIcon: compactIcon)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
            .frame(width: compactIcon ? 24 : 20)
        }
    }

    @ViewBuilder
    private func addLabel(category: LibraryItem.Category, compactIcon: Bool) -> some View {
        if compactIcon {
            Image(systemName: category.icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(category.uiColor)
                .frame(width: 18, height: 18)
        } else {
            Image(systemName: "plus")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
                .frame(width: 18, height: 18)
        }
    }

    // MARK: - Tree construction

    private func buildTrees(for category: LibraryItem.Category) -> [FSNode] {
        buildCategoryTrees(items: store.items(for: category))
    }

    // MARK: - Auto-expand

    private func autoExpand() {
        for cat in categories {
            let all = store.items(for: cat)
            let grouped = Dictionary(grouping: all.filter { $0.folderOrigin != nil },
                                     by: { $0.folderOrigin! })
            for (folderName, items) in grouped {
                _ = items
                _ = folderName
            }
            // All folders start collapsed; the user expands what they
            // care about. Auto-expanding the repo root + its immediate
            // children floods the panel with file rows on every launch.
        }
    }

    // MARK: - File / folder pickers

    private func pickFile(for cat: LibraryItem.Category) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true; panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { store.add(url: url, category: cat) }
        if selectedURL == nil { selectedURL = panel.urls.first }
    }

    private func pickFolder(for cat: LibraryItem.Category) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false; panel.prompt = "Add Folder"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        store.addFolder(url: url, category: cat)
        expandedPaths.insert(url.path)
    }
}
