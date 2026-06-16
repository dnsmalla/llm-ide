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
    /// Git status decoration (nil → undecorated / clean). VS Code-style.
    var gitStatus: GitStatusStore.Decoration? = nil

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
                    .foregroundStyle(gitColor ?? folderTint ?? FileIconKit.folderColor)
                    .frame(width: 16)
                Text(name)
                    .font(Typography.filename)
                    .foregroundStyle(gitColor ?? .primary)
                    .strikethrough(gitStatus == .deleted)
                    .lineLimit(1)
            } else {
                Spacer().frame(width: CGFloat(depth) * 14 + 14)
                Image(systemName: FileIconKit.icon(for: fileExtension))
                    .font(.system(size: 11))
                    .foregroundStyle(gitColor ?? FileIconKit.color(for: fileExtension))
                    .frame(width: 16)
                Text(name)
                    .font(Typography.filename)
                    .foregroundStyle(gitColor ?? .primary)
                    .strikethrough(gitStatus == .deleted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let letter = gitLetter {
                Text(letter)
                    .font(Typography.fileMeta.weight(.semibold))
                    .foregroundStyle((gitColor ?? .secondary).opacity(0.7))
                    .padding(.trailing, 2)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    /// VS Code-style status colors. Readable in both light and dark themes.
    private var gitColor: Color? {
        switch gitStatus {
        case .modified:   return Color(red: 0.85, green: 0.65, blue: 0.13)   // amber
        case .added, .untracked: return Color(red: 0.45, green: 0.62, blue: 0.20) // green
        case .deleted:    return Color(red: 0.80, green: 0.25, blue: 0.25)   // red
        case .conflicted: return .orange
        case .none:       return nil
        }
    }

    /// Trailing single-letter badge (M/A/U/D/C), VS Code-style.
    private var gitLetter: String? {
        switch gitStatus {
        case .modified:   return "M"
        case .added:      return "A"
        case .untracked:  return "U"
        case .deleted:    return "D"
        case .conflicted: return "C"
        case .none:       return nil
        }
    }
}
