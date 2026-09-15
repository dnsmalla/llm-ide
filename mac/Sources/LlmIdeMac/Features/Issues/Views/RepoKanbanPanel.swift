import SwiftUI

// Backend-agnostic kanban board for RepoIssue, giving GitHub the same board
// experience as GitLab's IssueKanbanPanel. Columns are derived from labels —
// the most common label namespace becomes the columns ("status::value" on
// GitLab, "status:value" on GitHub) — falling back to Open / Closed. Dragging
// a card rewrites the status label (or toggles state) via RepoBackend, so the
// board state lives in the provider's own labels and stays consistent across
// GitLab and GitHub. Adding an unknown label name on GitHub auto-creates it.

private struct RepoColumn: Identifiable {
    let id: String              // "__open__", "open", "closed", or a status value
    let title: String
    var issues: [RepoIssue]
    let groupPrefix: String?    // nil → open/closed fallback mode
}

struct RepoKanbanPanel: View {
    let issues: [RepoIssue]
    let labels: [RepoLabel]
    let backend: RepoBackendKind
    let client: RepoBackend
    let projectId: String
    var onSelect: (RepoIssue) -> Void
    var onIssueUpdate: (RepoIssue) -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var moving: Set<Int> = []
    @State private var moveError: String?

    // GitLab uses scoped labels ("prefix::value"); GitHub uses a flat
    // convention ("prefix:value"). The board derivation is otherwise identical.
    private var separator: String { backend == .gitlab ? "::" : ":" }

    // The label namespace shared by the most issues becomes the column axis.
    private var groupPrefix: String? {
        var count: [String: Int] = [:]
        for issue in issues {
            var seen = Set<String>()
            for lbl in issue.labels {
                let parts = lbl.components(separatedBy: separator)
                guard parts.count >= 2, !parts[0].isEmpty else { continue }
                let prefix = parts[0]
                if seen.insert(prefix).inserted { count[prefix, default: 0] += 1 }
            }
        }
        return count.max(by: { $0.value < $1.value })?.key
    }

    private var columns: [RepoColumn] {
        guard !issues.isEmpty else { return [] }
        if let prefix = groupPrefix {
            var map: [String: [RepoIssue]] = [:]
            var others: [RepoIssue] = []
            for issue in issues {
                if let lbl = issue.labels.first(where: { $0.hasPrefix(prefix + separator) }) {
                    let value = lbl.components(separatedBy: separator).dropFirst().joined(separator: separator)
                    map[value, default: []].append(issue)
                } else {
                    others.append(issue)
                }
            }
            var cols: [RepoColumn] = []
            if !others.isEmpty {
                cols.append(.init(id: "__open__", title: "No status", issues: others, groupPrefix: prefix))
            }
            for key in map.keys.sorted() {
                cols.append(.init(id: key, title: key, issues: map[key]!, groupPrefix: prefix))
            }
            return cols
        }
        // Fallback: open vs closed.
        let open = issues.filter { $0.isOpen }
        let closed = issues.filter { !$0.isOpen }
        var cols: [RepoColumn] = []
        if !open.isEmpty   { cols.append(.init(id: "open",   title: "Open",   issues: open,   groupPrefix: nil)) }
        if !closed.isEmpty { cols.append(.init(id: "closed", title: "Closed", issues: closed, groupPrefix: nil)) }
        return cols
    }

    var body: some View {
        let t = theme.current
        if issues.isEmpty {
            EmptyStateView(icon: "square.grid.3x3", title: "No issues",
                           message: "Select a project and adjust the filters to populate the board.")
        } else {
            VStack(spacing: 0) {
                if let err = moveError {
                    Text(err).font(Typography.caption).foregroundStyle(t.danger)
                        .padding(.horizontal, Spacing.lg).padding(.vertical, 4)
                }
                GeometryReader { proxy in
                    ScrollView(.horizontal, showsIndicators: true) {
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(columns) { col in
                                column(col, height: proxy.size.height - 24, t: t)
                                    .frame(width: 280)
                            }
                        }
                        .padding(12)
                    }
                    .background(t.body)
                }
            }
        }
    }

    @ViewBuilder
    private func column(_ col: RepoColumn, height: CGFloat, t: Theme) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(accent(col, t)).frame(width: 8, height: 8)
                Text(col.title).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(t.text).lineLimit(1)
                Spacer(minLength: 0)
                Text("\(col.issues.count)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(t.surface2))
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(t.surface)
            Divider().background(t.border.opacity(0.6))

            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 8) {
                    ForEach(col.issues) { issue in
                        card(issue, t: t)
                            .draggable(String(issue.number))
                            .onTapGesture { onSelect(issue) }
                    }
                    if col.issues.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: "arrow.down.circle").font(.system(size: 22)).foregroundStyle(t.border)
                            Text("Drop issues here").font(.system(size: 11)).foregroundStyle(t.textMuted)
                        }
                        .frame(maxWidth: .infinity, minHeight: 80)
                    }
                }
                .padding(8)
            }
            .frame(height: max(0, height - 44))
            .background(t.body.opacity(0.6))
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(t.border.opacity(0.5), lineWidth: 0.5))
        .dropDestination(for: String.self) { items, _ in
            guard let idStr = items.first else { return false }
            Task { await move(idStr: idStr, to: col) }
            return true
        }
    }

    @ViewBuilder
    private func card(_ issue: RepoIssue, t: Theme) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(issue.title)
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(t.text)
                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            if !issue.labels.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(issue.labels, id: \.self) { name in
                        LabelChip(name: name, color: color(for: name), small: true)
                    }
                }
            }
            // Weight badge — only when the issue carries a non-nil weight
            // (GitLab-only; GitHub always sets weight: nil so this is hidden).
            if let w = issue.weight {
                HStack(spacing: 3) {
                    Image(systemName: "scalemass").font(.system(size: 9, weight: .semibold))
                    Text("\(w)").font(.system(size: 10, weight: .semibold))
                }
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Capsule().fill(t.surface2))
                .foregroundStyle(t.textMuted)
            }
            HStack(spacing: 6) {
                Text("#\(issue.number)")
                    .font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(t.textMuted)
                Spacer(minLength: 0)
                if issue.commentCount > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "bubble.right").font(.system(size: 8))
                        Text("\(issue.commentCount)").font(.system(size: 9))
                    }.foregroundStyle(t.textMuted)
                }
                if !issue.assignees.isEmpty {
                    HStack(spacing: -5) {
                        ForEach(issue.assignees.prefix(3)) { a in
                            // RepoUser has a String id; seed the initials color from it.
                            UserAvatar(name: a.displayName, id: abs(a.id.hashValue),
                                       avatarUrl: a.avatarUrl, size: 20)
                        }
                    }
                }
                if moving.contains(issue.number) {
                    ProgressView().controlSize(.small).scaleEffect(0.6)
                } else if !issue.isOpen {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(t.accent3)
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border.opacity(0.4), lineWidth: 0.5))
        .shadow(color: Color.black.opacity(0.03), radius: 2, y: 1)
    }

    private func color(for name: String) -> Color? {
        labels.first(where: { $0.name == name }).flatMap { Color(hex: $0.color) }
    }

    private func accent(_ col: RepoColumn, _ t: Theme) -> Color {
        switch col.id {
        case "closed": return t.accent3
        case "open", "__open__": return t.textMuted
        default:
            let palette: [Color] = [t.accent, t.accent2, t.accent3, t.accent4, .purple, .orange]
            return palette[abs(col.id.hashValue) % palette.count]
        }
    }

    // MARK: - Drag-drop move

    private func move(idStr: String, to col: RepoColumn) async {
        guard let number = Int(idStr),
              let issue = issues.first(where: { $0.number == number }),
              !projectId.isEmpty else { return }
        if col.issues.contains(where: { $0.number == number }) { return }  // already here

        let payload: RepoIssuePayload
        if let prefix = col.groupPrefix {
            // Rewrite the status label: drop any existing "prefix<sep>*", add the
            // target column's value (unless dropping into the "No status" column).
            var newLabels = issue.labels.filter { !$0.hasPrefix(prefix + separator) }
            if col.id != "__open__" { newLabels.append("\(prefix)\(separator)\(col.id)") }
            payload = RepoIssuePayload(labels: newLabels)
        } else {
            payload = RepoIssuePayload(stateChange: col.id == "closed" ? .close : .reopen)
        }

        moving.insert(number); moveError = nil
        defer { moving.remove(number) }
        do {
            let updated = try await client.updateIssue(projectId: projectId, number: number, payload: payload)
            onIssueUpdate(updated)
        } catch {
            moveError = "Couldn't move #\(number): \(error.localizedDescription)"
        }
    }
}
