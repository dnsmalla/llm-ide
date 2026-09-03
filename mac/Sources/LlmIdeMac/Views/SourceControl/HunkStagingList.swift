// mac/Sources/LlmIdeMac/Views/SourceControl/HunkStagingList.swift
import SwiftUI

/// Native SwiftUI hunk list — the "act" half of Source Control's diff
/// experience, paired with `MonacoDiffView` (the "view" half). Chosen over
/// custom Monaco gutter widgets specifically because building interactive
/// decorations inside Monaco's rendered diff editor is real JS/DOM work
/// this environment cannot visually verify before shipping; a native list
/// needs none of that and is directly testable.
struct HunkStagingList: View {
    let hunks: [DiffHunk]
    var onStage: ((DiffHunk) -> Void)? = nil
    var onUnstage: ((DiffHunk) -> Void)? = nil

    @EnvironmentObject private var theme: ThemeStore

    private var isInteractive: Bool { onStage != nil || onUnstage != nil }

    /// A single lazily-rendered row: either a hunk's header/action bar, or
    /// one of its diff rows. Flattening hunks+rows into one sequence (rather
    /// than an outer `LazyVStack` over hunks with an inner plain `VStack`
    /// over rows) is what makes the list *actually* lazy — SwiftUI only
    /// builds `LazyVStack` children near the visible scroll region, but a
    /// non-lazy `VStack` nested inside one still builds ALL of its children
    /// eagerly the moment its parent hunk row is realised. An untracked file
    /// is synthesized as a single hunk containing every line
    /// (`SourceControlService.diff`), so without flattening, opening a
    /// 5,000-line new file built ~20,000 views in one layout pass.
    private enum Item: Identifiable {
        case header(hunkIndex: Int, hunk: DiffHunk)
        case row(hunkIndex: Int, rowIndex: Int, row: DiffRow)

        var id: String {
            switch self {
            case .header(let hunkIndex, _): return "h\(hunkIndex)"
            case .row(let hunkIndex, let rowIndex, _): return "h\(hunkIndex)r\(rowIndex)"
            }
        }
    }

    private var items: [Item] {
        var result: [Item] = []
        result.reserveCapacity(hunks.reduce(0) { $0 + $1.rows.count + 1 })
        for (hunkIndex, hunk) in hunks.enumerated() {
            result.append(.header(hunkIndex: hunkIndex, hunk: hunk))
            for (rowIndex, row) in hunk.rows.enumerated() {
                result.append(.row(hunkIndex: hunkIndex, rowIndex: rowIndex, row: row))
            }
        }
        return result
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(items) { item in
                    switch item {
                    case .header(let hunkIndex, let hunk):
                        hunkHeader(hunk)
                            .padding(.top, hunkIndex == 0 ? 0 : 8)
                    case .row(_, _, let row):
                        rowView(row)
                    }
                }
            }
            .padding(8)
        }
    }

    @ViewBuilder
    private func hunkHeader(_ hunk: DiffHunk) -> some View {
        HStack {
            Text(hunk.header.isEmpty ? " " : hunk.header)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
            if isInteractive {
                if let onUnstage {
                    Button("Unstage") { onUnstage(hunk) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                if let onStage {
                    Button("Stage") { onStage(hunk) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 6)
        .padding(.bottom, 2)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private let lineNumWidth: CGFloat = 38

    @ViewBuilder
    private func rowView(_ row: DiffRow) -> some View {
        let (sign, bg, fg): (String, Color, Color) = {
            switch row.kind {
            case .insert:  return ("+", theme.current.diffAddedBg, theme.current.diffAddedFg)
            case .delete:  return ("−", theme.current.diffDeletedBg, theme.current.diffDeletedFg)
            case .context: return (" ", .clear, .secondary)
            }
        }()
        HStack(spacing: 0) {
            Text(row.oldLine.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .frame(width: lineNumWidth, alignment: .trailing)
                .padding(.trailing, 6)
            Text(row.newLine.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .frame(width: lineNumWidth, alignment: .trailing)
                .padding(.trailing, 8)
            // Sign column. The raw "+"/"−" glyphs read as punctuation to
            // VoiceOver, so we replace them with descriptive labels (and hide
            // the column entirely for unchanged context rows).
            Text(sign)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(fg.opacity(0.7))
                .frame(width: 14, alignment: .center)
                .accessibilityLabel({
                    switch row.kind {
                    case .insert:  return "Added line"
                    case .delete:  return "Removed line"
                    case .context: return ""
                    }
                }())
                .accessibilityHidden(row.kind == .context)
            Text(row.text.isEmpty ? " " : row.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(fg)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.leading, 2)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
        .background(bg)
    }
}
