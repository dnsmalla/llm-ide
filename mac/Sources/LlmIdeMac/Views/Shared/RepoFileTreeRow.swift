// FSNode-driven row that visually matches the Library tab's
// FSNodeRow, but uses Button-tap callbacks instead of List(selection:)
// tag binding. Used by RegressionView so it can render the same
// LibraryItemStore-backed tree the Library tab shows, while still
// owning its tap behaviour (which routes through SourceSelection
// rather than a plain URL?).
//
// Recursion is type-safe — children render the same struct, no
// AnyView gymnastics needed since this isn't a @ViewBuilder.

import SwiftUI
import AppKit

struct RepoFileTreeRow: View {
    let node: FSNode
    let depth: Int
    @Binding var expandedPaths: Set<String>
    let onSelect: (URL) -> Void
    let isSelected: (URL) -> Bool

    init(node: FSNode,
         depth: Int,
         expandedPaths: Binding<Set<String>>,
         isSelected: @escaping (URL) -> Bool = { _ in false },
         onSelect: @escaping (URL) -> Void) {
        self.node = node
        self.depth = depth
        self._expandedPaths = expandedPaths
        self.isSelected = isSelected
        self.onSelect = onSelect
    }

    var body: some View {
        if node.isFile {
            fileRow
        } else {
            folderRow
            if expandedPaths.contains(node.id) {
                ForEach(node.children) { child in
                    RepoFileTreeRow(
                        node: child,
                        depth: depth + 1,
                        expandedPaths: $expandedPaths,
                        isSelected: isSelected,
                        onSelect: onSelect
                    )
                }
            }
        }
    }

    // MARK: - Folder row (matches FSNodeRow.folderRow visuals)

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
        .listRowSeparator(.hidden)
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }

    // MARK: - File row (matches FSNodeRow.fileRow visuals)

    private var fileRow: some View {
        let ext = node.url.pathExtension.lowercased()
        let selected = isSelected(node.url)
        return Button {
            onSelect(node.url)
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
        .listRowSeparator(.hidden)
        .background(selected ? Color.accentColor.opacity(0.18) : Color.clear)
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }
}
