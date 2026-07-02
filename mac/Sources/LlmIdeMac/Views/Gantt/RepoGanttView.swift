// Backend-agnostic timeline view. GitHub issues carry no native start/due
// dates, so we supply them from OUR scheduling overlay (LlmIdeAPIClient
// issue-schedule, backed by /kb/issue-schedule). Rendering, top to bottom:
//
//   • Scheduled issues (overlay has a start or due) — one row each, with a
//     real start→due bar. Tapping opens the schedule editor. This is the
//     gantt-parity win for GitHub.
//   • Milestones — one row each; bar spans the milestone's start (or earliest
//     issue createdAt) to its dueDate (or latest closedAt).
//   • Remaining issues without a milestone — a "No milestone" row of chips.
//
// Same project picker + backend toggle as RepoIssuesView. AppShell routes
// all providers here; GitLab-specific affordances (weight, native due-date
// editing) are gated via capability flags on the active backend.

import SwiftUI

struct RepoGanttView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    /// Backend client for our server (the scheduling overlay store). Distinct
    /// from `currentClient`, which talks directly to GitLab/GitHub.
    let api: LlmIdeAPIClient

    // ── Backend selection
    @State private var activeBackend: RepoBackendKind = .github
    @State private var projects: [RepoProject] = []
    @State private var selectedProject: RepoProject?
    @State private var projectsLoading = false
    @State private var projectsError: String?

    // ── Data
    @State private var milestones: [RepoMilestone] = []
    @State private var issues: [RepoIssue] = []
    // Per-issue scheduling overlay (issue number → schedule), GitHub only.
    @State private var schedules: [Int: LlmIdeAPIClient.IssueSchedule] = [:]
    @State private var loading = false
    @State private var loadError: String?

    @State private var detailIssue: RepoIssue?
    @State private var schedulingIssue: RepoIssue?

    // GitHub is the provider whose issues need our overlay; GitLab carries
    // native scheduling. The overlay editor is offered for GitHub only.
    private var overlayEnabled: Bool { currentClient.usesScheduleOverlay }

    private var availableBackends: [RepoBackendKind] {
        var out: [RepoBackendKind] = []
        if !config.gitLabToken.isEmpty { out.append(.gitlab) }
        if !config.gitHubToken.isEmpty { out.append(.github) }
        return out
    }

    private var currentClient: RepoBackend {
        switch activeBackend {
        case .gitlab: return GitLabClient(config: config)
        case .github: return GitHubClient(config: config)
        }
    }

    var body: some View {
        Group {
            if availableBackends.isEmpty {
                notConfigured
            } else {
                content
            }
        }
        .task { await initialLoad() }
        .onChange(of: activeBackend) { _, _ in Task { await switchBackend() } }
        .sheet(item: $detailIssue) { issue in
            RepoIssueDetailSheet(
                issue: issue,
                client: currentClient,
                projectId: selectedProject?.id ?? "",
                onIssueChanged: { updated in
                    if let i = issues.firstIndex(where: { $0.id == updated.id }) {
                        issues[i] = updated
                    }
                },
                onDismiss: { detailIssue = nil }
            )
        }
        .sheet(item: $schedulingIssue) { issue in
            IssueScheduleEditorSheet(
                api: api,
                provider: "github",
                repo: selectedProject?.fullName ?? "",
                issueNumber: issue.number,
                issueTitle: issue.title,
                existing: schedules[issue.number],
                onSaved: { saved in
                    if let s = saved { schedules[issue.number] = s }
                    else { schedules.removeValue(forKey: issue.number) }
                },
                onDismiss: { schedulingIssue = nil }
            )
            .environmentObject(theme)
        }
    }

    /// Open the right surface for an issue tap: the schedule editor on GitHub
    /// (the gantt's whole point is scheduling), the detail sheet on GitLab.
    private func handleIssueTap(_ issue: RepoIssue) {
        if overlayEnabled { schedulingIssue = issue } else { detailIssue = issue }
    }

    @ViewBuilder
    private var notConfigured: some View {
        EmptyStateView(
            icon: "lock.shield",
            title: "No repository connected",
            message: "Add a GitLab or GitHub Personal Access Token in Settings to start a timeline.",
            actionLabel: "Open Settings",
            action: { NotificationCenter.default.post(name: .openSettings, object: nil) }
        )
    }

    private var content: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().background(theme.current.border)
            timeline
        }
        .background(theme.current.body)
    }

    // MARK: - Header

    private var headerBar: some View {
        let t = theme.current
        return HStack(spacing: 0) {
            if availableBackends.count > 1 {
                backendPicker
                Divider().frame(height: 20).padding(.horizontal, 14)
            }
            projectDropdown
            Spacer()
            if loading {
                ProgressView().controlSize(.small).scaleEffect(0.75).padding(.trailing, 8)
            }
            Button {
                Task { await reload() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.textMuted)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2.opacity(0.8)))
            }
            .buttonStyle(.plain)
            .disabled(selectedProject == nil || loading)
            .help("Refresh  ⌘R")
            .keyboardShortcut("r", modifiers: .command)
            .padding(.leading, 8)
        }
        .padding(.horizontal, Spacing.lg)
        .frame(height: 46)
        .background(t.surface)
    }

    private var backendPicker: some View {
        let t = theme.current
        return HStack(spacing: 4) {
            ForEach(availableBackends, id: \.self) { backend in
                let active = (backend == activeBackend)
                Button {
                    if activeBackend != backend { activeBackend = backend }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: backend.sfSymbol).font(.system(size: 10))
                        Text(backend.displayName).font(Typography.captionStrong)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(RoundedRectangle(cornerRadius: 7)
                        .fill(active ? t.surface2.opacity(0.7) : Color.clear))
                    .foregroundStyle(active ? t.text : t.textMuted)
                    .opacity(active ? 1 : 0.7)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var projectDropdown: some View {
        RepoProjectDropdown(
            projects: projects,
            selected: $selectedProject,
            isLoading: projectsLoading,
            backendDisplayName: activeBackend.displayName,
            onSelect: { _ in Task { await reload() } }
        )
    }

    // MARK: - Timeline

    @ViewBuilder
    private var timeline: some View {
        let t = theme.current
        if let err = loadError {
            EmptyStateView(icon: "exclamationmark.triangle",
                           title: "Failed to load timeline",
                           message: err,
                           actionLabel: "Retry",
                           action: { Task { await reload() } },
                           iconColor: t.danger)
        } else if selectedProject == nil {
            EmptyStateView(icon: "calendar",
                           title: "Pick a project",
                           message: "Choose one of your saved \(activeBackend.displayName) projects to see its timeline.")
        } else if rows.isEmpty, !loading {
            EmptyStateView(icon: "calendar.badge.exclamationmark",
                           title: "Nothing to chart yet",
                           message: "This project has no milestones or dated issues. Create a milestone or set a due date to see a timeline.")
        } else {
            ScrollView([.vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    chartHeader
                    Divider().background(t.border).padding(.horizontal, Spacing.md)
                    ForEach(rows) { row in
                        TimelineRowView(row: row,
                                        chartStart: chartRange.lowerBound,
                                        chartEnd: chartRange.upperBound,
                                        onIssueTap: { handleIssueTap($0) })
                            .padding(.vertical, 2)
                    }
                }
                .padding(Spacing.md)
            }
        }
    }

    /// Top header line showing month tick marks across the visible range.
    private var chartHeader: some View {
        let t = theme.current
        let range = chartRange
        return GeometryReader { geo in
            let width = geo.size.width - 220   // matches row label gutter
            let total = range.upperBound.timeIntervalSince(range.lowerBound)
            let ticks = monthTicks(in: range)
            ZStack(alignment: .leading) {
                HStack(spacing: 0) {
                    Spacer().frame(width: 220)
                    Rectangle().fill(t.surface2.opacity(0.4))
                        .frame(height: 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(ticks, id: \.self) { tick in
                    let x = 220 + CGFloat(tick.timeIntervalSince(range.lowerBound) / total) * max(width, 1)
                    Text(monthLabel(tick))
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                        .offset(x: x, y: 0)
                }
            }
        }
        .frame(height: 22)
    }

    // MARK: - Data + derived

    /// All rows shown in the chart, in display order:
    ///   • One row per milestone (sorted by dueDate ascending, then title).
    ///   • One "No milestone" catch-all row for orphan dated issues.
    private var rows: [TimelineRow] {
        var out: [TimelineRow] = []
        // 1. Per-issue scheduled rows (from our overlay) — the real gantt bars.
        //    These take precedence so a scheduled issue shows its own start→due
        //    bar instead of being folded into a milestone/orphan aggregate.
        let scheduledRows = scheduledIssueRows()
        out.append(contentsOf: scheduledRows)
        let scheduledIds: Set<Int> = overlayEnabled
            ? Set(schedules.keys.filter { hasSchedule(schedules[$0]) })
            : Set(issues.filter { $0.dueDate != nil }.map { $0.number })

        var orphanIssues = issues.filter { !scheduledIds.contains($0.number) }
        for ms in sortedMilestones {
            let inMilestone = orphanIssues.filter { $0.milestone?.id == ms.id }
            orphanIssues.removeAll { $0.milestone?.id == ms.id }
            let dates = milestoneRange(ms, issues: inMilestone)
            // Skip milestones we can't place anywhere on the chart.
            guard dates.start != nil || dates.end != nil else { continue }
            out.append(TimelineRow(
                id: "ms:" + ms.id,
                title: ms.title,
                subtitle: milestoneSubtitle(ms, inMilestone),
                isClosed: ms.state == "closed",
                tint: .milestone,
                range: dates,
                issues: inMilestone,
                milestoneState: ms.state
            ))
        }
        // Dated orphans (have at least a createdAt — almost always).
        let orphansWithDates = orphanIssues
            .filter { parseDate($0.createdAt) != nil }
        if !orphansWithDates.isEmpty {
            // Group as a single row chart-wise; render each issue as a chip.
            let earliest = orphansWithDates.compactMap { parseDate($0.createdAt) }.min()
            let latest = orphansWithDates.compactMap {
                parseDate($0.closedAt ?? "") ?? parseDate($0.createdAt)
            }.max()
            out.append(TimelineRow(
                id: "orphans",
                title: "No milestone",
                subtitle: "\(orphansWithDates.count) dated issues",
                isClosed: false,
                tint: .orphan,
                range: (earliest, latest),
                issues: orphansWithDates,
                milestoneState: nil
            ))
        }
        return out
    }

    private func hasSchedule(_ s: LlmIdeAPIClient.IssueSchedule?) -> Bool {
        guard let s else { return false }
        return s.startDate != nil || s.dueDate != nil
    }

    /// Build one row per issue that has a scheduling overlay with a start or
    /// due date. The bar spans start → due; when only one end is set we derive
    /// the other from the estimate (default 1 week) so the bar is always drawn.
    ///
    /// For GitLab (`!overlayEnabled`) we skip the overlay and instead build one
    /// row per issue that carries a native `dueDate`, using a fixed 7-day
    /// look-back as the bar start — the same 1-week fallback the overlay path uses.
    private func scheduledIssueRows() -> [TimelineRow] {
        if !overlayEnabled {
            var rows: [TimelineRow] = []
            for issue in issues {
                guard let due = parseDate(issue.dueDate ?? "") else { continue }
                let start = due.addingTimeInterval(-7 * 86_400)
                rows.append(TimelineRow(
                    id: "sched:\(issue.number)",
                    title: "#\(issue.number) \(issue.title)",
                    subtitle: "due \(prettyDate(issue.dueDate ?? ""))",
                    isClosed: !issue.isOpen,
                    tint: .scheduled,
                    range: (start, due),
                    issues: [issue],
                    milestoneState: nil
                ))
            }
            return rows.sorted {
                let l = $0.range.start ?? .distantFuture
                let r = $1.range.start ?? .distantFuture
                if l != r { return l < r }
                return $0.id < $1.id
            }
        }
        // ── existing overlay body (GitHub) ──────────────────────────────────
        let byNumber = Dictionary(issues.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a })
        var rows: [TimelineRow] = []
        for (num, sched) in schedules {
            guard hasSchedule(sched), let issue = byNumber[num] else { continue }
            let span = (sched.estimateDays ?? 7) * 86_400
            let start = parseDate(sched.startDate ?? "")
            let due = parseDate(sched.dueDate ?? "")
            let s = start ?? due?.addingTimeInterval(-span)
            let e = due ?? start?.addingTimeInterval(span)
            rows.append(TimelineRow(
                id: "sched:\(num)",
                title: "#\(num) \(issue.title)",
                subtitle: scheduledSubtitle(sched, issue),
                isClosed: !issue.isOpen,
                tint: .scheduled,
                range: (s, e),
                issues: [issue],
                milestoneState: nil
            ))
        }
        // Earliest start first, then issue number for stable ordering.
        return rows.sorted {
            let l = $0.range.start ?? .distantFuture
            let r = $1.range.start ?? .distantFuture
            if l != r { return l < r }
            return $0.id < $1.id
        }
    }

    private func scheduledSubtitle(_ s: LlmIdeAPIClient.IssueSchedule, _ issue: RepoIssue) -> String {
        var parts: [String] = []
        if let start = s.startDate { parts.append(prettyDate(start)) }
        if let due = s.dueDate { parts.append("→ \(prettyDate(due))") }
        if let est = s.estimateDays, est > 0 { parts.append("· \(estimateLabel(est))") }
        if !s.dependsOn.isEmpty { parts.append("· blocks on #\(s.dependsOn.map(String.init).joined(separator: ", #"))") }
        return parts.isEmpty ? "scheduled" : parts.joined(separator: " ")
    }

    private func estimateLabel(_ est: Double) -> String {
        let n = est.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(est)) : String(format: "%.1f", est)
        return "\(n)d"
    }

    private var sortedMilestones: [RepoMilestone] {
        milestones.sorted { lhs, rhs in
            let l = parseDate(lhs.dueDate ?? "") ?? .distantFuture
            let r = parseDate(rhs.dueDate ?? "") ?? .distantFuture
            if l != r { return l < r }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    private func milestoneRange(_ ms: RepoMilestone, issues: [RepoIssue]) -> (start: Date?, end: Date?) {
        let dueDate  = parseDate(ms.dueDate ?? "")
        let startDate = parseDate(ms.startDate ?? "")
        let earliestIssue = issues.compactMap { parseDate($0.createdAt) }.min()
        let latestClose = issues.compactMap { parseDate($0.closedAt ?? "") }.max()
        // Prefer explicit dates; fall back to issue activity inside the
        // milestone so an undated milestone still draws SOMETHING.
        let start = startDate ?? earliestIssue ?? dueDate?.addingTimeInterval(-7 * 86_400)
        let end   = dueDate ?? latestClose ?? earliestIssue?.addingTimeInterval(7 * 86_400)
        return (start, end)
    }

    private func milestoneSubtitle(_ ms: RepoMilestone, _ inMs: [RepoIssue]) -> String {
        let total = inMs.count
        let closed = inMs.filter { !$0.isOpen }.count
        if let due = ms.dueDate, !due.isEmpty {
            return "\(closed)/\(total) closed · due \(prettyDate(due))"
        }
        return "\(closed)/\(total) closed"
    }

    /// Visible date range — spans 14 days before the earliest row event
    /// to 14 days after the latest, with sensible defaults when empty.
    private var chartRange: ClosedRange<Date> {
        let allStarts = rows.compactMap { $0.range.start }
        let allEnds = rows.compactMap { $0.range.end }
        let now = Date()
        let earliest = allStarts.min() ?? now.addingTimeInterval(-30 * 86_400)
        let latest = allEnds.max() ?? now.addingTimeInterval(30 * 86_400)
        return earliest.addingTimeInterval(-14 * 86_400)
            ... latest.addingTimeInterval(14 * 86_400)
    }

    private func monthTicks(in range: ClosedRange<Date>) -> [Date] {
        let cal = Calendar.current
        var ticks: [Date] = []
        var c = cal.date(from: cal.dateComponents([.year, .month], from: range.lowerBound)) ?? range.lowerBound
        while c < range.upperBound {
            if c > range.lowerBound { ticks.append(c) }
            c = cal.date(byAdding: .month, value: 1, to: c) ?? range.upperBound
        }
        return ticks
    }

    private func monthLabel(_ date: Date) -> String {
        AppDateFormatter.monthAndYear(date)
    }

    private func parseDate(_ s: String) -> Date? {
        if s.isEmpty { return nil }
        return AppDateFormatter.parseISO(s) ?? AppDateFormatter.parseDateOnly(s)
    }

    private func prettyDate(_ s: String) -> String {
        guard let d = parseDate(s) else { return s }
        return AppDateFormatter.monthDayYear(d)
    }

    // MARK: - Loading

    private func initialLoad() async {
        if availableBackends == [.gitlab] { activeBackend = .gitlab }
        else if availableBackends == [.github] { activeBackend = .github }
        else if !availableBackends.contains(activeBackend) {
            activeBackend = availableBackends.first ?? .github
        }
        await switchBackend()
    }

    private func switchBackend() async {
        projects = []
        milestones = []
        issues = []
        selectedProject = nil
        await loadProjects()
    }

    private func loadProjects() async {
        guard availableBackends.contains(activeBackend) else { return }
        projectsLoading = true
        projectsError = nil
        defer { projectsLoading = false }
        do {
            let fetched = try await currentClient.listProjects()
            projects = fetched.sorted {
                $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending
            }
            if selectedProject == nil { selectedProject = projects.first }
            await reload()
        } catch {
            projectsError = error.localizedDescription
        }
    }

    private func reload() async {
        guard let project = selectedProject else { return }
        loading = true; loadError = nil
        defer { loading = false }
        do {
            // Pull milestones + a wide set of issues (all states) so we
            // can place closed items too. Milestones and the first issue
            // page run in parallel; remaining issue pages then drain so a
            // long timeline isn't truncated to one backend page.
            async let msTask = currentClient.listMilestones(projectId: project.id)
            async let firstIssues = currentClient.listIssues(
                projectId: project.id,
                filter: RepoIssueFilter(state: .all),
                page: 1
            )
            milestones = try await msTask
            issues = try await drainIssues(project: project, firstPage: firstIssues)
            // Merge our scheduling overlay (GitHub only). Best-effort: if the
            // backend is unreachable the gantt still renders milestone bars.
            if overlayEnabled {
                schedules = (try? await api.listIssueSchedules(provider: "github", repo: project.fullName)) ?? [:]
            } else {
                schedules = [:]
            }
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Continues paging issues from page 2 onward, reusing the already-
    /// fetched first page. Dedups by id and caps pages so an out-of-range
    /// page that a backend clamps can't loop forever.
    private func drainIssues(project: RepoProject,
                             firstPage: [RepoIssue]) async throws -> [RepoIssue] {
        var all: [RepoIssue] = []
        var seen = Set<String>()
        let maxPages = 20
        all.append(contentsOf: firstPage.filter { seen.insert($0.id).inserted })
        if firstPage.isEmpty { return all }
        for page in 2...maxPages {
            let batch = try await currentClient.listIssues(
                projectId: project.id, filter: RepoIssueFilter(state: .all), page: page)
            let fresh = batch.filter { seen.insert($0.id).inserted }
            if fresh.isEmpty { break }
            all.append(contentsOf: fresh)
        }
        return all
    }
}

// MARK: - Row model

private enum RowTint { case milestone, orphan, scheduled }

private struct TimelineRow: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let isClosed: Bool
    let tint: RowTint
    let range: (start: Date?, end: Date?)
    let issues: [RepoIssue]
    let milestoneState: String?    // nil for orphan row
}

private struct TimelineRowView: View {
    let row: TimelineRow
    let chartStart: Date
    let chartEnd: Date
    var onIssueTap: (RepoIssue) -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let t = theme.current
        HStack(spacing: 12) {
            // Left gutter: title + subtitle. Fixed width to keep bars aligned.
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Circle()
                        .fill(rowColor(t))
                        .frame(width: 7, height: 7)
                    Text(row.title)
                        .font(Typography.bodyStrong)
                        .foregroundStyle(t.text)
                        .lineLimit(1).truncationMode(.tail)
                }
                Text(row.subtitle)
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1)
            }
            .frame(width: 220, alignment: .leading)

            // Right side: chart bar.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Rectangle().fill(t.surface2.opacity(0.25))
                        .frame(height: 18)
                    if let start = row.range.start, let end = row.range.end ?? row.range.start {
                        let barView = bar(start: max(start, chartStart),
                                          end: min(end, chartEnd),
                                          in: geo.size.width, t: t)
                        // A scheduled row IS one issue — tap its bar to edit the schedule.
                        if row.tint == .scheduled, let issue = row.issues.first {
                            Button { onIssueTap(issue) } label: { barView }
                                .buttonStyle(.plain)
                        } else {
                            barView
                        }
                    }
                    if row.tint == .orphan {
                        ForEach(row.issues) { issue in
                            issueChip(issue, in: geo.size.width, t: t)
                        }
                    }
                }
            }
            .frame(height: 22)
        }
        .contentShape(Rectangle())
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 4)
    }

    private func rowColor(_ t: Theme) -> Color {
        switch row.tint {
        case .milestone: return row.isClosed ? t.accent3 : t.accent
        case .orphan:    return t.textMuted
        case .scheduled: return row.isClosed ? t.accent3 : t.accent2
        }
    }

    private func bar(start: Date, end: Date, in width: CGFloat, t: Theme) -> some View {
        let total = chartEnd.timeIntervalSince(chartStart)
        let s = max(0, CGFloat(start.timeIntervalSince(chartStart) / total)) * width
        let e = min(1, CGFloat(end.timeIntervalSince(chartStart) / total)) * width
        let w = max(2, e - s)
        let color = rowColor(t)
        return RoundedRectangle(cornerRadius: 4)
            .fill(row.isClosed ? color : color.opacity(0.4))
            .overlay(RoundedRectangle(cornerRadius: 4)
                .strokeBorder(color, lineWidth: 1))
            .frame(width: w, height: 14)
            .offset(x: s, y: 0)
            .help("\(row.title) · \(monthDayString(start)) → \(monthDayString(end))")
    }

    private func issueChip(_ issue: RepoIssue, in width: CGFloat, t: Theme) -> some View {
        let created = AppDateFormatter.parseISO(issue.createdAt) ?? Date()
        let total = chartEnd.timeIntervalSince(chartStart)
        let x = max(0, CGFloat(created.timeIntervalSince(chartStart) / total)) * width
        return Button {
            onIssueTap(issue)
        } label: {
            Circle()
                .fill(issue.isOpen ? t.accent2 : t.textMuted.opacity(0.5))
                .frame(width: 7, height: 7)
                .offset(x: x - 3.5, y: 0)
        }
        .buttonStyle(.plain)
        .help("#\(issue.number) \(issue.title)")
    }

    private func monthDayString(_ d: Date) -> String {
        AppDateFormatter.monthDay(d)
    }
}
