import SwiftUI
import RepoKit

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
    /// When non-nil, each row shows a selection checkbox; tapping it toggles
    /// membership in `selectedIDs` (bulk-action mode). Nil → no checkboxes.
    var selectedIDs: Set<String> = []
    var onToggleSelect: ((RepoIssue) -> Void)? = nil

    /// Whether an issue still belongs in the list under the active state filter.
    /// Shared by the single-issue and bulk-action update paths so a closed issue
    /// disappears from an "Open" list (and vice versa) consistently.
    static func stillFits(_ issue: RepoIssue, filterState: RepoIssueFilter.IssueState) -> Bool {
        switch filterState {
        case .all:    return true
        case .opened: return issue.isOpen
        case .closed: return !issue.isOpen
        }
    }

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
            if let onToggleSelect {
                let checked = selectedIDs.contains(issue.id)
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                    .font(.system(size: 13))
                    .foregroundStyle(checked ? t.accent : t.textMuted)
                    .padding(.top, 2)
                    .contentShape(Rectangle())
                    .onTapGesture { onToggleSelect(issue) }
            }
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
                    if issue.labels.count > 4 {
                        Text("+\(issue.labels.count - 4)")
                            .font(Typography.caption).foregroundStyle(t.textMuted)
                            .help(issue.labels.dropFirst(4).joined(separator: ", "))
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
                    .help(shown.displayName)
            }
            if overflow.extra > 0 {
                Text("+\(overflow.extra)").font(Typography.caption).foregroundStyle(t.textMuted)
                    .help(issue.assignees.dropFirst().map(\.displayName).joined(separator: ", "))
            }
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
        .background(zebra ? t.rowAlt : Color.clear)
    }

    /// `#N · opened <relative>[ · milestone]`. Uses the app's shared relative
    /// formatter (minutes/hours/days/absolute) — same granularity as the detail
    /// sheet — instead of hand-rolled day math. Milestone omitted when absent.
    static func metaLine(for issue: RepoIssue, now: Date) -> String {
        var parts = ["#\(issue.number)"]
        let rel = AppDateFormatter.relativeVerbose(issue.createdAt, now: now)
        if !rel.isEmpty { parts.append("opened \(rel)") }
        if let ms = issue.milestone { parts.append(ms.title) }
        return parts.joined(separator: " · ")
    }

    /// First assignee to show as an avatar, plus how many more are hidden.
    static func assigneeOverflow(_ assignees: [RepoUser]) -> (shown: RepoUser?, extra: Int) {
        (assignees.first, max(0, assignees.count - 1))
    }
}
