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

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                    hunkBlock(hunk)
                }
            }
            .padding(8)
        }
    }

    @ViewBuilder
    private func hunkBlock(_ hunk: DiffHunk) -> some View {
        VStack(alignment: .leading, spacing: 2) {
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
            ForEach(Array(hunk.rows.enumerated()), id: \.offset) { _, row in
                rowView(row)
            }
        }
        .padding(6)
        .background(Color(nsColor: .textBackgroundColor))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.2)))
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
            Text(sign)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(fg.opacity(0.7))
                .frame(width: 14, alignment: .center)
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
