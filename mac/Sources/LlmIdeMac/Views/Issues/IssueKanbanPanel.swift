import SwiftUI

// MARK: - Column data model

private struct KanbanColumnData: Identifiable {
    let id: String             // "open", "closed", or scoped-label value like "調査中"
    let title: String
    var issues: [GitLabIssue]
    let groupPrefix: String?   // nil → open/closed fallback mode
}

// MARK: - Panel

struct IssueKanbanPanel: View {
    let issues: [GitLabIssue]
    @Binding var selectedIssue: GitLabIssue?
    let gitlab: GitLabClient
    let project: GitLabProject?
    let labels: [GitLabLabel]
    let onIssueUpdate: (GitLabIssue) -> Void

    @EnvironmentObject var theme: ThemeStore

    // The label prefix that appears in the most issues (e.g. "PJステータス").
    private var groupPrefix: String? {
        var count: [String: Int] = [:]
        for issue in issues {
            var seen = Set<String>()
            for lbl in issue.labels {
                let parts = lbl.components(separatedBy: "::")
                guard parts.count >= 2 else { continue }
                let prefix = parts[0]
                if seen.insert(prefix).inserted { count[prefix, default: 0] += 1 }
            }
        }
        return count.max(by: { $0.value < $1.value })?.key
    }

    private var columns: [KanbanColumnData] {
        guard !issues.isEmpty else { return [] }

        if let prefix = groupPrefix {
            var map: [String: [GitLabIssue]] = [:]
            var others: [GitLabIssue] = []
            for issue in issues {
                if let lbl = issue.labels.first(where: { $0.hasPrefix(prefix + "::") }) {
                    let value = lbl.components(separatedBy: "::").dropFirst().joined(separator: "::")
                    map[value, default: []].append(issue)
                } else {
                    others.append(issue)
                }
            }
            var cols: [KanbanColumnData] = []
            if !others.isEmpty {
                cols.append(.init(id: "__open__", title: "Open", issues: others, groupPrefix: prefix))
            }
            for key in map.keys.sorted() {
                cols.append(.init(id: key, title: key, issues: map[key]!, groupPrefix: prefix))
            }
            return cols
        }

        // Fallback: open vs closed
        let open   = issues.filter {  $0.isOpen }
        let closed = issues.filter { !$0.isOpen }
        var cols: [KanbanColumnData] = []
        if !open.isEmpty   { cols.append(.init(id: "open",   title: "Open",   issues: open,   groupPrefix: nil)) }
        if !closed.isEmpty { cols.append(.init(id: "closed", title: "Closed", issues: closed, groupPrefix: nil)) }
        return cols
    }

    var body: some View {
        if issues.isEmpty {
            EmptyStateView(
                icon: "square.grid.3x3",
                title: "No issues",
                message: "Select a project and adjust the filters to populate the board."
            )
        } else {
            GeometryReader { proxy in
                ScrollView(.horizontal, showsIndicators: true) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(columns) { col in
                            KanbanColumn(
                                columnData: col,
                                colHeight: proxy.size.height - 24,
                                selectedIssue: $selectedIssue,
                                labelList: labels,
                                onDrop: { idStr in
                                    Task { await move(idStr: idStr, to: col) }
                                }
                            )
                            .frame(width: 270)
                        }
                    }
                    .padding(12)
                }
                .background(theme.current.body)
            }
        }
    }

    // MARK: - Drag-drop move

    private func move(idStr: String, to col: KanbanColumnData) async {
        guard let issueId = Int(idStr),
              let issue = issues.first(where: { $0.id == issueId }),
              let project else { return }
        // Already in target column — skip
        if col.issues.contains(where: { $0.id == issueId }) { return }

        let payload: GitLabIssuePayload
        if let prefix = col.groupPrefix {
            // Remove existing scoped label for this prefix, add the new one
            var newLabels = issue.labels.filter { !$0.hasPrefix(prefix + "::") }
            if col.id != "__open__" { newLabels.append("\(prefix)::\(col.id)") }
            payload = GitLabIssuePayload(title: issue.title, labels: newLabels.joined(separator: ","))
        } else {
            // Open/closed toggle
            let stateEvent = col.id == "closed" ? "close" : "reopen"
            payload = GitLabIssuePayload(title: issue.title, stateEvent: stateEvent)
        }

        if let updated = try? await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload) {
            onIssueUpdate(updated)
        }
    }
}

// MARK: - Column

private struct KanbanColumn: View {
    let columnData: KanbanColumnData
    let colHeight: CGFloat
    @Binding var selectedIssue: GitLabIssue?
    let labelList: [GitLabLabel]
    let onDrop: (String) -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var isDropTarget = false

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            // ── Header ────────────────────────────────────────────
            HStack(spacing: 8) {
                Circle()
                    .fill(accentColor(t: t))
                    .frame(width: 8, height: 8)
                Text(columnData.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(t.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text("\(columnData.issues.count)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(t.surface2))
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(t.surface)

            Divider().background(t.border.opacity(0.6))

            // ── Card list ─────────────────────────────────────────
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    ForEach(columnData.issues) { issue in
                        KanbanCard(
                            issue: issue,
                            isSelected: selectedIssue?.id == issue.id,
                            labelList: labelList
                        )
                        .draggable(String(issue.id))
                        .onTapGesture { selectedIssue = issue }
                    }
                    if columnData.issues.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: "arrow.down.circle")
                                .font(.system(size: 22))
                                .foregroundStyle(isDropTarget ? t.accent : t.border)
                            Text("Drop issues here")
                                .font(.system(size: 11))
                                .foregroundStyle(isDropTarget ? t.accent : t.textMuted)
                        }
                        .frame(maxWidth: .infinity, minHeight: 80)
                    }
                }
                .padding(8)
            }
            .frame(height: max(0, colHeight - 44))
            .background(isDropTarget
                ? t.accent.opacity(t.isDark ? 0.08 : 0.04)
                : t.body.opacity(0.6))
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(
                    isDropTarget ? t.accent.opacity(0.5) : t.border.opacity(0.5),
                    lineWidth: isDropTarget ? 2 : 0.5
                )
        )
        .shadow(color: Color.black.opacity(0.04), radius: 3, y: 1)
        .animation(.easeInOut(duration: 0.12), value: isDropTarget)
        .dropDestination(for: String.self) { items, _ in
            guard let id = items.first else { return false }
            onDrop(id)
            return true
        } isTargeted: { isDropTarget = $0 }
    }

    private func accentColor(t: Theme) -> Color {
        switch columnData.id {
        case "closed":          return t.accent3
        case "open", "__open__": return t.textMuted
        default:
            // Stable color derived from the column name
            let colors: [Color] = [t.accent, t.accent2, t.accent3, t.accent4, .purple, .orange]
            return colors[abs(columnData.id.hashValue) % colors.count]
        }
    }
}

// MARK: - Card

private struct KanbanCard: View {
    let issue: GitLabIssue
    let isSelected: Bool
    let labelList: [GitLabLabel]

    @EnvironmentObject var theme: ThemeStore
    @State private var isHovered = false

    private func resolvedColor(for name: String) -> Color? {
        labelList.first(where: { $0.name == name }).flatMap { Color(hex: $0.color) }
    }

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 8) {

            // ── Title ─────────────────────────────────────────────
            Text(issue.title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(t.text)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            // ── Label chips ───────────────────────────────────────
            if !issue.labels.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(issue.labels, id: \.self) { lbl in
                        LabelChip(name: lbl, color: resolvedColor(for: lbl), small: true)
                    }
                }
            }

            // ── Milestone + due date ──────────────────────────────
            if issue.milestone != nil || issue.dueDate != nil {
                HStack(spacing: 10) {
                    if let ms = issue.milestone {
                        HStack(spacing: 3) {
                            Image(systemName: "diamond")
                                .font(.system(size: 8, weight: .semibold))
                            Text(ms.title)
                                .font(.system(size: 10))
                                .lineLimit(1)
                        }
                        .foregroundStyle(t.accent.opacity(0.8))
                    }
                    if let due = issue.dueDate {
                        HStack(spacing: 3) {
                            Image(systemName: "calendar")
                                .font(.system(size: 8))
                            Text(AppDateFormatter.dueDateDisplay(due))
                                .font(.system(size: 10))
                        }
                        .foregroundStyle(AppDateFormatter.isDuePast(due) ? t.danger : t.textMuted)
                    }
                }
            }

            // ── Footer ────────────────────────────────────────────
            HStack(spacing: 6) {
                HStack(spacing: 3) {
                    Image(systemName: "doc.text").font(.system(size: 8))
                    Text("#\(issue.iid)")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                }
                .foregroundStyle(t.textMuted)

                Spacer(minLength: 0)

                if issue.userNotesCount > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "bubble.right").font(.system(size: 8))
                        Text("\(issue.userNotesCount)").font(.system(size: 9))
                    }
                    .foregroundStyle(t.textMuted)
                }

                if !issue.assignees.isEmpty {
                    HStack(spacing: -5) {
                        ForEach(issue.assignees.prefix(3)) { a in
                            UserAvatar(user: a, size: 20)
                        }
                    }
                }

                statusBadge(t: t)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isSelected
                    ? t.accent.opacity(t.isDark ? 0.14 : 0.07)
                    : (isHovered ? t.surface2 : t.surface))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    isSelected ? t.accent.opacity(0.45) : t.border.opacity(0.4),
                    lineWidth: isSelected ? 1.2 : 0.5
                )
        )
        .shadow(color: Color.black.opacity(isHovered ? 0.07 : 0.03), radius: isHovered ? 5 : 2, y: 1)
        .onHover { isHovered = $0 }
        .animation(.easeInOut(duration: 0.1), value: isHovered)
    }

    @ViewBuilder
    private func statusBadge(t: Theme) -> some View {
        let inProgress = issue.labels.contains {
            $0.localizedCaseInsensitiveContains("progress") ||
            $0.localizedCaseInsensitiveContains("着手")
        }
        if !issue.isOpen {
            HStack(spacing: 3) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 11)).foregroundStyle(t.accent3)
                Text("Closed")
                    .font(.system(size: 9, weight: .medium)).foregroundStyle(t.accent3)
            }
        } else if inProgress {
            HStack(spacing: 3) {
                Circle().fill(t.accent).frame(width: 8, height: 8)
                Text("In progress")
                    .font(.system(size: 9, weight: .medium)).foregroundStyle(t.accent)
            }
        } else {
            HStack(spacing: 3) {
                Circle().strokeBorder(t.textMuted.opacity(0.6), lineWidth: 1.5).frame(width: 8, height: 8)
                Text("To do")
                    .font(.system(size: 9, weight: .medium)).foregroundStyle(t.textMuted)
            }
        }
    }
}
