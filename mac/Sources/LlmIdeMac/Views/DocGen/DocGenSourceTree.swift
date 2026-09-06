import SwiftUI

/// Step 2 of Doc Gen: tick source files or whole folders, across three Library
/// categories. Trees are built with the same helpers the Library tab uses, so
/// the hierarchy shown here cannot drift from the hierarchy shown there.
struct DocGenSourceTree: View {
    @ObservedObject var vm: DocGenViewModel
    @Binding var isExpanded: Bool

    @Environment(LibraryItemStore.self) private var itemStore
    @EnvironmentObject private var theme: ThemeStore

    /// Meetings are deliberately absent: generated meeting notes already land
    /// in `llm-doc/`, which the LLM Doc tab covers.
    private static let categories: [LibraryItem.Category] = [.code, .notes, .data]

    @AppStorage("docgen.sourceTab") private var selectedTabRaw = LibraryItem.Category.code.rawValue
    @State private var expandedPaths: Set<String> = []

    private var selectedTab: LibraryItem.Category {
        LibraryItem.Category(rawValue: selectedTabRaw) ?? .code
    }

    /// The server accepts at most 20 sources. Selection is never blocked at
    /// this limit — the user is only told, rather than having extras
    /// silently dropped on generate.
    private static let sourceLimit = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DocGenSectionHeader(
                title: "Sources",
                icon: "tray.full",
                color: .indigo,
                isExpanded: $isExpanded)

            if isExpanded {
                tabPicker
                if vm.selectedSources.count > Self.sourceLimit {
                    overflowWarning
                }
                treeBody
            }
        }
    }

    private var tabPicker: some View {
        Picker("", selection: $selectedTabRaw) {
            ForEach(Self.categories, id: \.self) { category in
                Text(category.sectionTitle).tag(category.rawValue)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var overflowWarning: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(theme.current.warning)
            Text("\(vm.selectedSources.count) selected — only \(Self.sourceLimit) can be sent")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private var treeBody: some View {
        let trees = buildTrees(for: selectedTab)
        if trees.isEmpty {
            Text("No \(selectedTab.sectionTitle.lowercased()) files in Library yet")
                .font(.caption)
                .foregroundStyle(.quaternary)
                .italic()
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
        } else {
            // Computed once per render: rows read this dictionary (O(1)) rather
            // than each walking their own subtree via
            // DocGenTreeSelection.state(for:selected:). See the doc comment on
            // `DocGenTreeSelection.states(forForest:selected:)`.
            let states = DocGenTreeSelection.states(forForest: trees, selected: vm.selectedSources)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(trees) { root in
                    DocGenTreeRow(
                        node: root,
                        depth: 0,
                        vm: vm,
                        expandedPaths: $expandedPaths,
                        tint: selectedTab.uiColor,
                        states: states)
                }
            }
            .padding(.bottom, 10)
        }
    }

    /// Code and llm-doc render as real nested hierarchies keyed on `treePath`;
    /// data keeps the flat folder grouping. Same split as `FileTreePanel`.
    private func buildTrees(for category: LibraryItem.Category) -> [FSNode] {
        let items = itemStore.items(for: category)
        return category.rendersNestedTree
            ? buildCodeTrees(items: items)
            : buildCategoryTrees(items: items)
    }
}

/// One row of the Doc Gen source tree. Separate struct so the recursion doesn't
/// hit SwiftUI's @ViewBuilder recursion limit — same reason `FSNodeRow` exists.
private struct DocGenTreeRow: View {
    let node: FSNode
    let depth: Int
    @ObservedObject var vm: DocGenViewModel
    @Binding var expandedPaths: Set<String>
    let tint: Color

    /// Selection state for every node in the current forest, keyed by path —
    /// computed once by the parent (`DocGenSourceTree.treeBody`) so this row
    /// never walks its own subtree just to read its state (controller ruling
    /// R11: that walk, repeated per visible folder row on every click, is
    /// O(visible rows × subtree size) on a repo-sized Code tree).
    let states: [String: DocGenTreeSelection.State]

    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        if node.isFile {
            fileRow
        } else {
            folderRow
            if expandedPaths.contains(node.id) {
                ForEach(node.children) { child in
                    DocGenTreeRow(node: child, depth: depth + 1, vm: vm,
                                  expandedPaths: $expandedPaths, tint: tint, states: states)
                }
            }
        }
    }

    private var selectionState: DocGenTreeSelection.State {
        states[node.id] ?? .none
    }

    private var folderRow: some View {
        let expanded = expandedPaths.contains(node.id)
        return HStack(spacing: 7) {
            checkbox(state: selectionState) {
                vm.selectedSources = DocGenTreeSelection.toggled(
                    node: node, selected: vm.selectedSources)
            }
            Button {
                if expanded { expandedPaths.remove(node.id) } else { expandedPaths.insert(node.id) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 8)
                    Image(systemName: "folder.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(tint.opacity(0.8))
                    Text(node.name)
                        .font(.callout)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, CGFloat(depth) * 12 + 14)
        .padding(.trailing, 14)
        .padding(.vertical, 4)
        .help(node.name)
    }

    private var fileRow: some View {
        let selected = selectionState == .all
        return HStack(spacing: 7) {
            checkbox(state: selectionState) {
                vm.selectedSources = DocGenTreeSelection.toggled(
                    node: node, selected: vm.selectedSources)
            }
            Image(systemName: iconForExt(node.url.pathExtension.lowercased()))
                .font(.system(size: 10))
                .foregroundStyle(selected ? tint : Color.secondary.opacity(0.5))
                .frame(width: 13)
            Text(node.name)
                .font(.callout)
                .lineLimit(1)
            Spacer(minLength: 0)
            if let item = node.item, vm.unreadableSourceNames.contains(item.name) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(theme.current.warning)
                    .help("Could not read this file")
            }
        }
        .padding(.leading, CGFloat(depth) * 12 + 14)
        .padding(.trailing, 14)
        .padding(.vertical, 4)
        .background(selected ? theme.current.accent.opacity(0.07) : Color.clear)
        .help(node.name)
    }

    private func checkbox(state: DocGenTreeSelection.State,
                          toggle: @escaping () -> Void) -> some View {
        Button(action: toggle) {
            ZStack {
                RoundedRectangle(cornerRadius: 4)
                    .fill(state == .none ? Color(nsColor: .windowBackgroundColor) : theme.current.accent)
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(state == .none ? Color.secondary.opacity(0.3) : theme.current.accent,
                                  lineWidth: 1.2)
                switch state {
                case .none:    EmptyView()
                case .partial: Image(systemName: "minus")
                        .font(.system(size: 8, weight: .black)).foregroundStyle(.white)
                case .all:     Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .black)).foregroundStyle(.white)
                }
            }
            .frame(width: 14, height: 14)
        }
        .buttonStyle(.plain)
    }

    private func iconForExt(_ ext: String) -> String {
        switch ext {
        case "md", "txt":          return "doc.text"
        case "pdf":                return "doc.richtext"
        case "csv", "xlsx", "xls": return "tablecells"
        case "json":               return "curlybraces"
        default:                   return "doc"
        }
    }
}
