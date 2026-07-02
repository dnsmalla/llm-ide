import SwiftUI

/// GitLab-classic issue list: one two-line row per issue. No drag-to-recolumn —
/// GitLab's Issues page is a list, and status changes happen in the detail sheet.
struct RepoIssueListView: View {
    @EnvironmentObject var theme: ThemeStore

    let issues: [RepoIssue]
    let labels: [RepoLabel]
    let backend: RepoBackendKind
    let client: RepoBackend
    let projectId: String
    let onSelect: (RepoIssue) -> Void
    let onIssueUpdate: (RepoIssue) -> Void

    // Label color lookup by name (issues carry label names; RepoLabel carries a
    // "#rrggbb" hex). Returns nil when the label isn't in the loaded set, letting
    // LabelChip fall back to its name-derived palette color.
    private func color(for labelName: String) -> Color? {
        labels.first(where: { $0.name == labelName }).flatMap { Color(hex: $0.color) }
    }

    var body: some View {
        let t = theme.current
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(issues.enumerated()), id: \.element.id) { idx, issue in
                    row(issue, zebra: idx % 2 == 1, t: t)
                        .contentShape(Rectangle())
                        .onTapGesture { onSelect(issue) }
                    Divider().background(t.border.opacity(0.5))
                }
            }
        }
        .background(t.body)
    }

    @ViewBuilder
    private func row(_ issue: RepoIssue, zebra: Bool, t: Theme) -> some View {
        let overflow = Self.assigneeOverflow(issue.assignees)
        HStack(alignment: .top, spacing: Spacing.sm) {
            Circle()
                .fill(issue.isOpen ? t.success : t.textMuted)
                .frame(width: 9, height: 9)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(issue.title).font(Typography.bodyStrong).foregroundStyle(t.text)
                        .lineLimit(1)
                    ForEach(issue.labels.prefix(4), id: \.self) { name in
                        LabelChip(name: name, color: color(for: name), small: true)
                    }
                    if client.supportsWeight, let w = issue.weight {
                        Text("\(w)").font(Typography.mono)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 4).fill(t.surface2))
                            .foregroundStyle(t.textMuted)
                    }
                }
                Text(Self.metaLine(for: issue, now: Date()))
                    .font(Typography.caption).foregroundStyle(t.textMuted).lineLimit(1)
            }
            Spacer(minLength: Spacing.sm)
            if issue.commentCount > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "bubble.right").font(.system(size: 10))
                    Text("\(issue.commentCount)").font(Typography.caption)
                }.foregroundStyle(t.textMuted)
            }
            if let shown = overflow.shown {
                UserAvatar(name: shown.displayName, id: abs(shown.id.hashValue),
                           avatarUrl: shown.avatarUrl, size: 22)
            }
            if overflow.extra > 0 {
                Text("+\(overflow.extra)").font(Typography.caption).foregroundStyle(t.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
        .background(zebra ? t.rowAlt : Color.clear)
    }

    /// `#N · opened Nd ago[ · milestone]`. Milestone segment omitted when absent.
    static func metaLine(for issue: RepoIssue, now: Date) -> String {
        var parts = ["#\(issue.number)"]
        if let created = ISO8601DateFormatter().date(from: issue.createdAt) {
            let days = max(0, Int(now.timeIntervalSince(created) / 86_400))
            parts.append(days == 0 ? "opened today" : "opened \(days)d ago")
        }
        if let ms = issue.milestone { parts.append(ms.title) }
        return parts.joined(separator: " · ")
    }

    /// First assignee to show as an avatar, plus how many more are hidden.
    static func assigneeOverflow(_ assignees: [RepoUser]) -> (shown: RepoUser?, extra: Int) {
        (assignees.first, max(0, assignees.count - 1))
    }
}
