import SwiftUI

/// Presentation-only row used by all file-tree views (Library FSNodeRow,
/// Explorer). Takes scalars so it works with any
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
    var gitStatus: GitTruthStore.Decoration? = nil

    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        HStack(spacing: 4) {
            if isFolder {
                indentGuides(depth)
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
                indentGuides(depth)
                Spacer().frame(width: 10)   // aligns the file icon under sibling folder icons
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

    /// VSCode-style indent guides: one faint vertical rule per ancestor level,
    /// each 14pt wide so child rows line up under their parent's chevron.
    @ViewBuilder
    private func indentGuides(_ depth: Int) -> some View {
        if depth > 0 {
            HStack(spacing: 0) {
                ForEach(0..<depth, id: \.self) { _ in
                    Rectangle()
                        .fill(Color.secondary.opacity(0.18))
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .padding(.leading, 6)
                        .padding(.trailing, 7)
                }
            }
            .frame(height: 16)
        }
    }

    /// Status color, from the active palette — never a raw literal. Shared
    /// with the Source Control changes list via `Theme.color(for:)`, so both
    /// panels agree and Midnight reads correctly.
    private var gitColor: Color? {
        gitStatus.map { theme.current.color(for: $0) }
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
