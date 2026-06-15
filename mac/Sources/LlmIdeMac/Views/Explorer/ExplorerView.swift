import SwiftUI
import AppKit

/// Project file browser. Left pane is a lazy filesystem tree rooted at the
/// active project's local folder; right pane opens tapped files into
/// closable editor tabs (the same EditorTabBar + FileDetailView the Review
/// Code tab uses).
struct ExplorerView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var config: AppConfig

    // Lazy tree state: which folders are expanded, and a cache of each
    // expanded folder's children (filled on first expand so repeated
    // toggles don't re-hit the filesystem).
    @State private var expanded: Set<String> = []
    @State private var childrenCache: [String: [FileSystemTree.Node]] = [:]

    // Editor tabs.
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?

    /// Prefer the active CODE repo (matching Source Control / terminal); fall
    /// back to the active project's local folder. nil when neither is set.
    private var root: URL? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    var body: some View {
        HSplitView {
            treePane
                .frame(minWidth: 220, idealWidth: 280, maxWidth: 360)

            editorArea
                .frame(minWidth: 360, maxWidth: .infinity)
        }
        // Reset all per-project state when the active project changes, so the
        // tree, cache, and open tabs never show a previous project's files
        // (and the cache can't grow unbounded across switches).
        .onChange(of: root?.path) { _, _ in
            expanded.removeAll()
            childrenCache.removeAll()
            tabs.removeAll()
            activeTab = nil
        }
    }

    // MARK: - Tree pane

    @ViewBuilder
    private var treePane: some View {
        if let root {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(children(of: root)) { node in
                        treeRow(node, depth: 0)
                    }
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(NSColor.windowBackgroundColor))
        } else {
            emptyState
        }
    }

    /// Recursive row: a folder toggles expansion (and renders its children
    /// when expanded); a file opens a tab on tap. Returns AnyView so the
    /// opaque return type isn't defined in terms of itself (the recursive
    /// child call would otherwise be self-referential).
    private func treeRow(_ node: FileSystemTree.Node, depth: Int) -> AnyView {
        if node.isDirectory {
            let isExpanded = expanded.contains(node.id)
            return AnyView(
                VStack(alignment: .leading, spacing: 0) {
                    folderRow(node, depth: depth, expanded: isExpanded)
                    if isExpanded {
                        ForEach(children(of: node.url)) { child in
                            treeRow(child, depth: depth + 1)
                        }
                    }
                }
            )
        } else {
            return AnyView(fileRow(node, depth: depth))
        }
    }

    private func folderRow(_ node: FileSystemTree.Node, depth: Int, expanded isExpanded: Bool) -> some View {
        Button {
            toggle(node)
        } label: {
            HStack(spacing: 4) {
                if depth > 0 { Spacer().frame(width: CGFloat(depth) * 14) }
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: isExpanded ? "folder.fill" : "folder")
                    .font(Typography.filename)
                    .foregroundStyle(FileIconKit.folderColor)
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
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }

    private func fileRow(_ node: FileSystemTree.Node, depth: Int) -> some View {
        let ext = node.url.pathExtension.lowercased()
        let selected = activeTab == node.url
        return Button {
            open(node.url)
        } label: {
            HStack(spacing: 4) {
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(selected ? Color.accentColor.opacity(0.18) : Color.clear)
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }

    // MARK: - Editor area

    @ViewBuilder
    private var editorArea: some View {
        VStack(spacing: 0) {
            if !tabs.isEmpty {
                EditorTabBar(tabs: $tabs, activeTab: $activeTab)
                Divider()
            }
            if let url = activeTab {
                FileDetailView(url: url)
                    .id(url)
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "folder")
                        .font(.system(size: 40, weight: .thin))
                        .foregroundStyle(.quaternary)
                    Text("Select a file to view")
                        .font(Typography.emptyTitle)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
            }
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "folder")
                .font(.system(size: 40, weight: .thin))
                .foregroundStyle(.quaternary)
            Text("Open a project or activate a repo to browse files.")
                .font(Typography.emptyTitle)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }

    // MARK: - Behavior

    /// Lazily resolved children of a directory, cached by path so repeated
    /// renders/toggles don't re-enumerate.
    private func children(of dir: URL) -> [FileSystemTree.Node] {
        if let cached = childrenCache[dir.path] { return cached }
        let nodes = FileSystemTree.children(of: dir)
        childrenCache[dir.path] = nodes
        return nodes
    }

    private func toggle(_ node: FileSystemTree.Node) {
        if expanded.contains(node.id) {
            expanded.remove(node.id)
        } else {
            // Warm the cache on first expand.
            if childrenCache[node.url.path] == nil {
                childrenCache[node.url.path] = FileSystemTree.children(of: node.url)
            }
            expanded.insert(node.id)
        }
    }

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }
}
