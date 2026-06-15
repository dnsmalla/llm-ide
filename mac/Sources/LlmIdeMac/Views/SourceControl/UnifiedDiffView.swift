import SwiftUI

/// Read-only unified diff renderer: colored +/− rows with old/new line
/// gutters. Fed by parsed git hunks (UnifiedDiffParser). Horizontal +
/// vertical scroll, no wrap (the VSCode/Cursor pattern). Visual style
/// mirrors `UpdateFileSheet.diffRowView`: green insert / red delete row
/// backgrounds, monospaced font, theme-driven colors.
struct UnifiedDiffView: View {
    let hunks: [DiffHunk]
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        if hunks.isEmpty {
            VStack {
                Text("No changes to show")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                        Text(hunk.header)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(theme.current.accent2)
                            .padding(.vertical, 2)
                            .padding(.horizontal, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(theme.current.surface2.opacity(0.5))
                        ForEach(Array(hunk.rows.enumerated()), id: \.offset) { _, row in
                            rowView(row)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func rowView(_ row: DiffRow) -> some View {
        let t = theme.current
        let bg: Color = row.kind == .insert ? Color.green.opacity(0.14)
                      : row.kind == .delete ? Color.red.opacity(0.14) : .clear
        let sign = row.kind == .insert ? "+" : row.kind == .delete ? "−" : " "
        HStack(spacing: 0) {
            gutter(row.oldLine)
            gutter(row.newLine)
            Text(sign)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .frame(width: 14)
            Text(row.text.isEmpty ? " " : row.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(t.text)
                .fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
        .background(bg)
    }

    private func gutter(_ n: Int?) -> some View {
        Text(n.map(String.init) ?? "")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.current.textMuted.opacity(0.6))
            .frame(width: 40, alignment: .trailing)
            .padding(.trailing, 4)
    }
}
