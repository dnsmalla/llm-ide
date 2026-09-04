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
    // No `isSelected`: this view renders no selection state of its own — the
    // enclosing `List`/row draws the highlight. It used to take one anyway,
    // which cost the Explorer a `store.selection.contains(row.url)` lookup,
    // and an extra `@Observable` dependency edge, on EVERY row of EVERY
    // render to feed a parameter the body never read.
    var folderTint: Color? = nil   // nil → default folder color
    // file extension for FileIconKit (files only)
    var fileExtension: String = ""
    /// Git status decoration (nil → undecorated / clean). VS Code-style.
    var gitStatus: GitTruthStore.Decoration? = nil
    /// When non-nil (Explorer's `List`-based tree), the disclosure chevron
    /// becomes its own button, so expanding a folder does NOT go through the
    /// row's click. That separation is what makes ⌘/⇧ multi-select work on
    /// folders — clicking a folder's body selects it like any other row
    /// instead of also toggling it. `nil` (Library's `FileTreePanel`) keeps
    /// the previous static chevron and needs no change.
    var onToggleChevron: (() -> Void)? = nil

    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        HStack(spacing: 4) {
            if isFolder {
                indentGuides(depth)
                if let onToggleChevron {
                    Button(action: onToggleChevron) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 10)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isExpanded ? "Collapse \(name)" : "Expand \(name)")
                } else {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 10)
                }
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
