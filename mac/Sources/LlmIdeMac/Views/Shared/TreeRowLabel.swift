import SwiftUI

/// Presentation-only row used by all file-tree views (Library FSNodeRow,
/// Regression RepoFileTreeRow, Explorer). Takes scalars so it works with any
/// node model (eager FSNode or lazy FileSystemTree.Node). Each tree keeps its
/// own recursion + selection/tap model; this only renders the label.
struct TreeRowLabel: View {
    let name: String
    let isFolder: Bool
    let isExpanded: Bool      // ignored for files
    let depth: Int
    let isSelected: Bool
    var folderTint: Color? = nil   // nil → default folder color
    // file extension for FileIconKit (files only)
    var fileExtension: String = ""

    var body: some View {
        HStack(spacing: 4) {
            if isFolder {
                if depth > 0 { Spacer().frame(width: CGFloat(depth) * 14) }
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: isExpanded ? "folder.fill" : "folder")
                    .font(Typography.filename)
                    .foregroundStyle(folderTint ?? FileIconKit.folderColor)
                    .frame(width: 16)
                Text(name)
                    .font(Typography.filename)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            } else {
                Spacer().frame(width: CGFloat(depth) * 14 + 14)
                Image(systemName: FileIconKit.icon(for: fileExtension))
                    .font(.system(size: 11))
                    .foregroundStyle(FileIconKit.color(for: fileExtension))
                    .frame(width: 16)
                Text(name)
                    .font(Typography.filename)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
