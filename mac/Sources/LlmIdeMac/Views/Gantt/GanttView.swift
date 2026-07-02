import SwiftUI
import RepoKit
import AppKit

private extension Calendar {
    func dayOffset(_ days: Int, from date: Date) -> Date {
        self.date(byAdding: .day, value: days, to: date) ?? date
    }
}

// MARK: - Zoom

enum GanttZoom: String, CaseIterable, Identifiable {
    case day, week, month
    var id: String { rawValue }
    var dayWidth: CGFloat {
        switch self {
        case .day:   return 32
        case .week:  return 14
        case .month: return 5
        }
    }
    var label: String {
        switch self {
        case .day:   return "Day"
        case .week:  return "Week"
        case .month: return "Month"
        }
    }
}

// MARK: - Main view

struct GanttView: View {
    @ObservedObject var vm: GanttViewModel
    let backend: RepoBackend
    let project: RepoProject
    var projects: [RepoProject] = []
    var onProjectChange: (RepoProject) -> Void = { _ in }
    var api: LlmIdeAPIClient? = nil

    @EnvironmentObject var theme: ThemeStore

    @State private var zoom: GanttZoom = .week
    @State private var hoverIssueId: String?
    /// Issue whose detail/schedule sheet is open (tap a bar/row to reschedule).
    @State private var detailIssue: RepoIssue?
    /// Repo labels (with hex colors), loaded alongside the VM so bars can be
    /// tinted by the issue's first color-bearing label. Kept local to the view
    /// (rather than on GanttViewModel) since it's presentation-only.
    @State private var labels: [RepoLabel] = []

    private let rowHeight: CGFloat = 32
    private let labelWidth: CGFloat = 320
    private let topBandHeight: CGFloat = 28
    private let midBandHeight: CGFloat = 24
    private let bottomBandHeight: CGFloat = 16
    private let markerBandHeight: CGFloat = 36

    private var headerHeight: CGFloat {
        let base: CGFloat
        switch zoom {
        case .day:          base = topBandHeight + midBandHeight + bottomBandHeight + 2
        case .week, .month: base = topBandHeight + midBandHeight + 2
        }
        return base + markerBandHeight
    }
    private var markerBandY: CGFloat { headerHeight - markerBandHeight }

    var body: some View {
        let t = theme.current
        let issues = vm.filteredIssues
        let rows = vm.rows                 // milestone-swimlane rows (headers + issues)
        let (start, end) = vm.timelineBounds
        let cal = vm.layoutCalendar
        let days = max(1, cal.dateComponents([.day],
            from: cal.startOfDay(for: start),
            to: cal.startOfDay(for: end)).day ?? 1)
        let dayWidth = zoom.dayWidth

        VStack(spacing: 0) {
            headerBar(t: t)
            Divider().background(t.border)
            GanttFilterBar(vm: vm)
            Divider().background(t.border)
            if vm.isLoading {
                loadingView(t: t)
            } else if let err = vm.errorMessage {
                errorView(err, t: t)
            } else if issues.isEmpty {
                EmptyStateView(
                    icon: "calendar.badge.exclamationmark",
                    title: "No issues with dates",
                    message: "Issues need a due date or milestone to appear on the chart. Uncheck \"Hide undated\" in the filter bar to see all issues."
                )
            } else {
                HStack(alignment: .top, spacing: 0) {
                    leftColumn(rows: rows, t: t)
                    Divider().background(t.border)
                    GeometryReader { geo in
                        let viewportDays = max(1, Int(ceil(geo.size.width / dayWidth)))
                        let displayDays  = max(days, viewportDays)
                        let displayWidth = CGFloat(displayDays) * dayWidth
                        let chartHeight  = max(CGFloat(rows.count) * rowHeight,
                                               geo.size.height - headerHeight)
                        let todayOffset  = cal.dateComponents([.day],
                            from: cal.startOfDay(for: start),
                            to: cal.startOfDay(for: Date())).day ?? -1
                        ScrollViewReader { proxy in
                            ScrollView([.horizontal, .vertical]) {
                                ZStack(alignment: .topLeading) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        timelineHeader(start: start, days: displayDays,
                                                       dayWidth: dayWidth, totalWidth: displayWidth, t: t, cal: cal)
                                        Canvas { ctx, size in
                                            drawChart(ctx: ctx, size: size, rows: rows,
                                                      start: start, days: displayDays,
                                                      dayWidth: dayWidth, cal: cal, t: t)
                                        }
                                        .frame(width: displayWidth, height: chartHeight)
                                    }
                                    todayMarker(start: start, days: displayDays, dayWidth: dayWidth,
                                                totalWidth: displayWidth, totalHeight: chartHeight + headerHeight,
                                                cal: cal, t: t)
                                    Color.clear.frame(width: 1, height: 1)
                                        .id("anchor-today")
                                        .offset(x: max(0, CGFloat(todayOffset) * dayWidth - geo.size.width / 3))
                                    Color.clear.frame(width: 1, height: 1).id("anchor-start")
                                }
                                .frame(minWidth: geo.size.width, minHeight: geo.size.height, alignment: .topLeading)
                            }
                            .background(t.body)
                            .onAppear { scrollToToday(proxy: proxy, offset: todayOffset, displayDays: displayDays) }
                            .onChange(of: vm.issues.count) { _, _ in
                                scrollToToday(proxy: proxy, offset: todayOffset, displayDays: displayDays)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(theme.current.body)
        .task(id: project.id) {
            await vm.load(backend: backend, project: project, api: api)
            labels = (try? await backend.listLabels(projectId: project.id)) ?? []
        }
        // Tap a bar/row to reschedule: the shared detail sheet routes due-date
        // editing to the schedule-overlay editor (GitHub) or a native date
        // picker (GitLab). Reload on change so bars/dependencies redraw.
        .sheet(item: $detailIssue) { issue in
            RepoIssueDetailSheet(
                issue: issue,
                client: backend,
                projectId: project.id,
                projectFullName: project.fullName,
                api: api,
                onIssueChanged: { _ in
                    Task { await vm.load(backend: backend, project: project, api: api) }
                },
                onDismiss: { detailIssue = nil }
            )
        }
    }

    private func scrollToToday(proxy: ScrollViewProxy, offset: Int, displayDays: Int) {
        guard offset >= 0 && offset <= displayDays else { return }
        DispatchQueue.main.async {
            withAnimation(.none) { proxy.scrollTo("anchor-today", anchor: .topLeading) }
        }
    }

    // MARK: - States

    @ViewBuilder
    private func loadingView(t: Theme) -> some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading issues…")
                .font(Typography.body)
                .foregroundStyle(t.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func errorView(_ msg: String, t: Theme) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32, weight: .thin))
                .foregroundStyle(t.danger.opacity(0.7))
            Text(msg).font(Typography.caption).foregroundStyle(t.danger)
                .multilineTextAlignment(.center).frame(maxWidth: 360)
            Button("Retry") { Task { await vm.load(backend: backend, project: project, api: api) } }
                .buttonStyle(.borderedProminent).controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Header bar

    private func headerBar(t: Theme) -> some View {
        let c = vm.counts
        return HStack(spacing: 0) {
            // Project picker
            projectDropdown(t: t)

            Divider().frame(height: 20).padding(.horizontal, 12)

            // Zoom tabs
            zoomTab(zoom: .day,   color: t.accent,  t: t)
            zoomTab(zoom: .week,  color: t.accent2, t: t)
            zoomTab(zoom: .month, color: t.accent3, t: t)

            Spacer(minLength: 0)

            // Legend chips
            HStack(spacing: 10) {
                legendChip(key: "open",    color: t.accent2, label: "Open",    count: c.open,    t: t)
                legendChip(key: "closed",  color: t.accent3, label: "Closed",  count: c.closed,  t: t)
                legendChip(key: "overdue", color: t.danger,  label: "Overdue", count: c.overdue, t: t)

                Divider().frame(height: 14).padding(.horizontal, 4)

                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 1).fill(t.accent.opacity(0.85))
                        .frame(width: 2, height: 14)
                    Text("Today").font(.system(size: 11)).foregroundStyle(t.textMuted)
                }
                HStack(spacing: 5) {
                    Rectangle().fill(t.accent4)
                        .frame(width: 9, height: 9).rotationEffect(.degrees(45))
                        .frame(width: 13, height: 13)
                    Text("Milestone").font(.system(size: 11)).foregroundStyle(t.textMuted)
                }
            }
            .padding(.trailing, 20)
        }
        .frame(height: 46)
        .background(t.surface)
    }

    @ViewBuilder
    private func projectDropdown(t: Theme) -> some View {
        Menu {
            if projects.isEmpty {
                Label("No other projects", systemImage: "folder")
            } else {
                ForEach(projects) { p in
                    Button(p.name) { onProjectChange(p) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(project.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(t.text)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(t.textMuted)
            }
            .fixedSize()
        }
        .menuStyle(.borderlessButton)
        .padding(.leading, 16)
    }

    @ViewBuilder
    private func zoomTab(zoom z: GanttZoom, color: Color, t: Theme) -> some View {
        let active = zoom == z
        Button { zoom = z } label: {
            VStack(spacing: 0) {
                Text(z.label)
                    .font(.system(size: 12, weight: active ? .semibold : .regular))
                    .foregroundStyle(active ? t.text : t.textMuted)
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                Rectangle()
                    .fill(active ? color : Color.clear)
                    .frame(height: 2)
            }
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func legendChip(key: String, color: Color, label: String, count: Int, t: Theme) -> some View {
        let active = vm.visibleCategories.contains(key)
        return Button { vm.toggleCategory(key) } label: {
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(active ? color : color.opacity(0.25))
                    .frame(width: 10, height: 10)
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(active ? t.text : t.textMuted)
                    .strikethrough(!active, color: t.textMuted)
                Text("\(count)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(active ? color : t.textMuted)
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Capsule().fill(color.opacity(active ? 0.18 : 0.07)))
            }
            .padding(.horizontal, 7).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(active ? t.surface2.opacity(0.7) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 6)
                .stroke(active ? color.opacity(0.25) : Color.clear, lineWidth: 1))
            .opacity(active ? 1.0 : 0.6)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(active ? "Click to hide \(label.lowercased()) issues" : "Click to show \(label.lowercased()) issues")
    }

    // MARK: - Left column

    private func leftColumn(rows: [GanttViewModel.GanttRow], t: Theme) -> some View {
        VStack(spacing: 0) {
            HStack {
                SectionLabel("ISSUES", size: 11, tracking: 1.2)
                Spacer()
                Text("\(vm.filteredIssues.count) / \(vm.issues.count)")
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(t.textMuted)
            }
            .frame(height: headerHeight)
            .padding(.horizontal, Spacing.md)
            .background(t.surface)
            .overlay(Rectangle().fill(t.border).frame(height: 1), alignment: .bottom)

            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                        switch row {
                        case let .header(ms, count):
                            laneHeaderRow(milestone: ms, count: count, t: t)
                        case let .issue(issue):
                            issueRow(issue: issue, index: idx, t: t)
                        }
                    }
                }
            }
        }
        .frame(width: labelWidth)
        .background(t.body)
    }

    /// Milestone lane header in the left column: title, due date, issue count.
    /// "No milestone" lane uses a neutral label.
    private func laneHeaderRow(milestone: RepoMilestone?, count: Int, t: Theme) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "flag.fill").font(.system(size: 10)).foregroundStyle(t.accent2)
            Text(milestone?.title ?? "No milestone")
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(t.text).lineLimit(1)
            if let due = milestone?.dueDate {
                Text(due).font(.system(size: 9, design: .monospaced)).foregroundStyle(t.textMuted)
            }
            Spacer(minLength: 4)
            Text("\(count)").font(.system(size: 9, weight: .semibold))
                .foregroundStyle(t.textMuted)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Capsule().fill(t.surface2))
        }
        .padding(.horizontal, Spacing.md)
        .frame(height: rowHeight, alignment: .center)
        .background(t.surface.opacity(0.9))
        .overlay(Rectangle().fill(t.border.opacity(0.6)).frame(height: 1), alignment: .bottom)
    }

    private func issueRow(issue: RepoIssue, index: Int, t: Theme) -> some View {
        let overdue = isOverdue(issue)
        return HStack(spacing: 10) {
            Image(systemName: issue.state == "closed"
                ? "checkmark.circle.fill"
                : (overdue ? "exclamationmark.circle.fill" : "circle"))
                .font(.system(size: 12))
                .foregroundStyle(issue.state == "closed" ? t.accent3 : (overdue ? t.danger : t.accent2))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("#\(issue.number)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(t.textMuted)
                    if let ms = issue.milestone {
                        Text(ms.title).font(.system(size: 10))
                            .foregroundStyle(t.accent2).lineLimit(1)
                    }
                }
                Text(issue.title).font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.text).lineLimit(1)
            }
            Spacer(minLength: 4)
            // Stacked avatars. When the issue has no assignees we fall
            // back to the author's avatar at reduced opacity so the row
            // still tells you who's responsible / who filed it, instead
            // of looking empty.
            HStack(spacing: -6) {
                if issue.assignees.isEmpty {
                    UserAvatar(name: issue.author.displayName, id: abs(issue.author.id.hashValue),
                               avatarUrl: issue.author.avatarUrl, size: 20)
                        .opacity(0.45)
                        .overlay(Circle().stroke(t.body, lineWidth: 1.5))
                        .help("\(issue.author.displayName) (author) — unassigned")
                } else {
                    ForEach(issue.assignees.prefix(3)) { a in
                        UserAvatar(name: a.displayName, id: abs(a.id.hashValue),
                                   avatarUrl: a.avatarUrl, size: 20)
                            .overlay(Circle().stroke(t.body, lineWidth: 1.5))
                            .help(a.displayName)
                    }
                    if issue.assignees.count > 3 {
                        Text("+\(issue.assignees.count - 3)")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(t.textMuted)
                            .padding(.leading, 6)
                    }
                }
            }
        }
        .padding(.horizontal, Spacing.md)
        .frame(height: rowHeight, alignment: .center)
        .background(index.isMultiple(of: 2) ? t.rowAlt : .clear)
        .contentShape(Rectangle())
        .onHover { h in hoverIssueId = h ? issue.id : nil }
        .onTapGesture { detailIssue = issue }
    }

    // MARK: - Timeline header

    private func timelineHeader(start: Date, days: Int, dayWidth: CGFloat, totalWidth: CGFloat, t: Theme, cal: Calendar) -> some View {
        ZStack(alignment: .topLeading) {
            Rectangle().fill(t.surface).frame(width: totalWidth, height: headerHeight)
            switch zoom {
            case .day, .week:
                monthBand(start: start, days: days, dayWidth: dayWidth, cal: cal, t: t, withYear: true)
                dayNumberRow(start: start, days: days, dayWidth: dayWidth, cal: cal, t: t, weekOnly: zoom == .week)
                if zoom == .day { weekdayRow(start: start, days: days, dayWidth: dayWidth, cal: cal, t: t) }
            case .month:
                yearBand(start: start, days: days, dayWidth: dayWidth, cal: cal, t: t)
                monthBand(start: start, days: days, dayWidth: dayWidth, cal: cal, t: t, withYear: false, secondary: true)
            }
            Rectangle().fill(t.border).frame(width: totalWidth, height: 1).offset(y: headerHeight - 1)
            Rectangle().fill(t.border).frame(width: totalWidth, height: 1).offset(y: topBandHeight)
            Rectangle().fill(t.body).frame(width: totalWidth, height: markerBandHeight).offset(y: markerBandY)
            Rectangle().fill(t.border).frame(width: totalWidth, height: 1).offset(y: markerBandY)
            milestoneDiamonds(start: start, days: days, dayWidth: dayWidth, cal: cal, t: t)
        }
        .frame(width: totalWidth, height: headerHeight)
    }

    @ViewBuilder
    private func milestoneDiamonds(start: Date, days: Int, dayWidth: CGFloat, cal: Calendar, t: Theme) -> some View {
        ForEach(milestoneMarkers(start: start, days: days, cal: cal), id: \.id) { mk in
            VStack(spacing: 1) {
                Rectangle().fill(t.accent4).frame(width: 9, height: 9)
                    .rotationEffect(.degrees(45)).frame(width: 13, height: 13)
                Text(mk.title).font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(t.accent4).lineLimit(1).truncationMode(.tail)
                    .frame(minWidth: 160, maxWidth: 260)
            }
            .position(x: CGFloat(mk.dayOffset) * dayWidth + dayWidth / 2,
                      y: markerBandY + markerBandHeight / 2)
            .help(mk.tooltip)
            .allowsHitTesting(false)
        }
    }

    private struct MilestoneMarker: Identifiable {
        let id: String; let dayOffset: Int; let title: String; let tooltip: String
    }

    private func milestoneMarkers(start: Date, days: Int, cal: Calendar) -> [MilestoneMarker] {
        let vm = self.vm
        return vm.milestones.compactMap { ms in
            guard let dStr = ms.dueDate, let due = vm.parseDate(dStr) else { return nil }
            let off = cal.dateComponents([.day],
                from: cal.startOfDay(for: start), to: cal.startOfDay(for: due)).day ?? -1
            guard off >= 0 && off <= days else { return nil }
            return MilestoneMarker(id: ms.id, dayOffset: off, title: ms.title,
                                   tooltip: "\(ms.title) · \(AppDateFormatter.monthDayYear(due))")
        }
    }

    // MARK: - Header bands

    private func monthBand(start: Date, days: Int, dayWidth: CGFloat, cal: Calendar, t: Theme,
                            withYear: Bool, secondary: Bool = false) -> some View {
        let segs = monthSegments(start: start, days: days, cal: cal, withYear: withYear)
        let bandH: CGFloat = secondary ? midBandHeight : topBandHeight
        let bg: Color     = secondary ? t.surface : t.surface2
        let fg: Color     = secondary ? t.text : t.accent
        let fs: CGFloat   = secondary ? 12 : 13
        let yOff: CGFloat = secondary ? topBandHeight : 0
        return HStack(spacing: 0) {
            ForEach(segs, id: \.startDay) { seg in
                ZStack(alignment: .leading) {
                    Rectangle().fill(bg)
                    Text(seg.label).font(.system(size: fs, weight: .bold)).foregroundStyle(fg)
                        .lineLimit(1).padding(.leading, 8).padding(.trailing, 4)
                }
                .frame(width: CGFloat(seg.length) * dayWidth, height: bandH, alignment: .leading)
                .overlay(Rectangle().fill(t.border).frame(width: 1), alignment: .trailing)
                .clipped()
            }
        }
        .offset(y: yOff)
    }

    private func yearBand(start: Date, days: Int, dayWidth: CGFloat, cal: Calendar, t: Theme) -> some View {
        let segs = yearSegments(start: start, days: days, cal: cal)
        return HStack(spacing: 0) {
            ForEach(segs, id: \.startDay) { seg in
                ZStack {
                    Rectangle().fill(t.surface2)
                    Text(seg.label).font(.system(size: 14, weight: .bold)).foregroundStyle(t.accent)
                }
                .frame(width: CGFloat(seg.length) * dayWidth, height: topBandHeight)
                .overlay(Rectangle().fill(t.border).frame(width: 1), alignment: .trailing)
                .clipped()
            }
        }
    }

    private func dayNumberRow(start: Date, days: Int, dayWidth: CGFloat, cal: Calendar, t: Theme, weekOnly: Bool) -> some View {
        let meta = vm.dayMeta(start: start, days: days)
        return ForEach(0..<days, id: \.self) { i in
            let m       = meta[i]
            let weekend = m.isWeekend
            let today   = m.isToday
            let show    = !weekOnly || m.weekday == 2
            if show {
                let labelW  = weekOnly ? dayWidth * 7 : dayWidth
                let xOffset = weekOnly ? CGFloat(i) * dayWidth - (labelW - dayWidth) / 2 : CGFloat(i) * dayWidth
                Text(m.dayLabel)
                    .font(.system(size: 12, weight: today ? .bold : .semibold, design: .monospaced))
                    .foregroundStyle(today ? .white : (weekend ? t.textMuted : t.text))
                    .lineLimit(1).fixedSize()
                    .frame(width: labelW, height: midBandHeight - 4)
                    .background(Group {
                        if today { RoundedRectangle(cornerRadius: 4).fill(t.accent).frame(width: dayWidth - 2, height: midBandHeight - 6) }
                    })
                    .offset(x: xOffset, y: topBandHeight + 2)
            }
        }
    }

    @ViewBuilder
    private func weekdayRow(start: Date, days: Int, dayWidth: CGFloat, cal: Calendar, t: Theme) -> some View {
        let meta = vm.dayMeta(start: start, days: days)
        ForEach(0..<days, id: \.self) { i in
            let m       = meta[i]
            let weekend = m.isWeekend
            let today   = m.isToday
            Text(m.weekdayLabel)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(today ? t.accent : (weekend ? t.danger.opacity(0.85) : t.textMuted))
                .frame(width: dayWidth, height: bottomBandHeight - 2)
                .offset(x: CGFloat(i) * dayWidth, y: topBandHeight + midBandHeight + 2)
        }
    }

    // MARK: - Today marker

    @ViewBuilder
    private func todayMarker(start: Date, days: Int, dayWidth: CGFloat, totalWidth: CGFloat, totalHeight: CGFloat, cal: Calendar, t: Theme) -> some View {
        let off = cal.dateComponents([.day],
            from: cal.startOfDay(for: start), to: cal.startOfDay(for: Date())).day ?? -1
        if off >= 0 && off <= days {
            let x = CGFloat(off) * dayWidth + dayWidth / 2
            ZStack(alignment: .topLeading) {
                Rectangle().fill(t.accent.opacity(0.85))
                    .frame(width: 1.5, height: max(0, totalHeight - headerHeight))
                    .offset(x: x - 0.75, y: headerHeight)
                Text(todayPill())
                    .font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(t.accent))
                    .overlay(Capsule().stroke(.white.opacity(0.18), lineWidth: 0.5))
                    .fixedSize()
                    .position(x: x, y: markerBandY + markerBandHeight / 2)
            }
            .frame(width: totalWidth, height: totalHeight, alignment: .topLeading)
            .allowsHitTesting(false)
        }
    }

    private func todayPill() -> String {
        "Today · \(AppDateFormatter.monthDayYear(Date()))"
    }

    // MARK: - Canvas chart drawing

    private func drawChart(ctx: GraphicsContext, size: CGSize, rows: [GanttViewModel.GanttRow],
                            start: Date, days: Int, dayWidth: CGFloat, cal: Calendar, t: Theme) {
        // Row backgrounds: lane-header rows get a surface band; issue rows
        // alternate (zebra), matching the left column.
        for (i, row) in rows.enumerated() {
            let y = CGFloat(i) * rowHeight
            switch row {
            case .header:
                ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: rowHeight)),
                         with: .color(t.surface.opacity(0.9)))
            case .issue:
                if i.isMultiple(of: 2) {
                    ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: rowHeight)),
                             with: .color(t.rowAlt))
                }
            }
        }

        // Weekend tints + grid lines. The tint itself is only meaningful at
        // .day/.week zoom — at .month zoom each column spans many days so
        // shading individual weekends would just produce visual noise.
        let meta = vm.dayMeta(start: start, days: days)
        let showWeekendTint = zoom == .day || zoom == .week
        for i in 0..<days {
            let m = meta[i]
            let date = m.date
            let x = CGFloat(i) * dayWidth
            if showWeekendTint && m.isWeekend {
                ctx.fill(Path(CGRect(x: x, y: 0, width: dayWidth, height: size.height)),
                         with: .color(t.gridLine.opacity(0.35)))
            }
            if cal.component(.day, from: date) == 1 {
                ctx.stroke(
                    Path { p in p.move(to: .init(x: x, y: 0)); p.addLine(to: .init(x: x, y: size.height)) },
                    with: .color(t.gridLine), lineWidth: 1)
            } else if zoom == .day {
                ctx.stroke(
                    Path { p in p.move(to: .init(x: x, y: 0)); p.addLine(to: .init(x: x, y: size.height)) },
                    with: .color(t.gridLine.opacity(0.3)), lineWidth: 0.5)
            }
        }

        // Milestone dashed vertical lines
        for ms in vm.milestones {
            guard let dStr = ms.dueDate, let due = vm.parseDate(dStr) else { continue }
            let off = cal.dateComponents([.day],
                from: cal.startOfDay(for: start), to: cal.startOfDay(for: due)).day ?? -1
            guard off >= 0 && off <= days else { continue }
            let mx = CGFloat(off) * dayWidth + dayWidth / 2
            ctx.stroke(
                Path { p in p.move(to: .init(x: mx, y: 0)); p.addLine(to: .init(x: mx, y: size.height)) },
                with: .color(t.accent4.opacity(0.55)),
                style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }

        // Bar rects keyed by issue number, so dependency connectors (drawn
        // after all bars) can look up both endpoints regardless of row order.
        var barRects: [Int: CGRect] = [:]

        // Gantt bars (issue rows only; header rows are lane bands drawn above)
        for (idx, row) in rows.enumerated() {
            guard case let .issue(issue) = row else { continue }
            let s  = vm.startDate(for: issue)
            let e  = vm.endDate(for: issue) ?? cal.dayOffset(1, from: s)
            let offD = max(0, cal.dateComponents([.day],
                from: cal.startOfDay(for: start), to: cal.startOfDay(for: s)).day ?? 0)
            let lenD = max(1, cal.dateComponents([.day],
                from: cal.startOfDay(for: s), to: cal.startOfDay(for: e)).day ?? 1)
            let x = CGFloat(offD) * dayWidth
            let w = CGFloat(lenD) * dayWidth - 2
            let y = CGFloat(idx) * rowHeight + 6
            let h = rowHeight - 12

            let over = isOverdue(issue)
            // Prefer the issue's first color-bearing label (matches the
            // label chips shown elsewhere); fall back to state-based accent
            // when the issue has no label or the label name doesn't resolve
            // to a known repo label.
            let labelColor = issue.labels.first.flatMap { name in
                labels.first(where: { $0.name == name }).flatMap { Color(hex: $0.color) }
            }
            let barColor: Color = labelColor ?? (issue.state == "closed" ? t.accent3
                                : (over ? t.danger : t.accent2))
            let barRect = CGRect(x: x + 1, y: y, width: max(2, w), height: h)
            barRects[issue.number] = barRect
            let capsuleRadius = h / 2
            let bar = RoundedRectangle(cornerRadius: capsuleRadius)
                .path(in: barRect)

            // Soft drop shadow: a slightly larger, downward-offset capsule
            // drawn first so it reads as depth rather than a hard outline.
            let shadowRect = barRect.offsetBy(dx: 0, dy: 1.5)
            let shadow = RoundedRectangle(cornerRadius: capsuleRadius).path(in: shadowRect)
            ctx.fill(shadow, with: .color(t.isDark ? .black.opacity(0.35) : .black.opacity(0.14)))

            ctx.fill(bar, with: .linearGradient(
                Gradient(colors: [barColor.opacity(0.95), barColor.opacity(0.70)]),
                startPoint: .init(x: x, y: y), endPoint: .init(x: x, y: y + h)))

            ctx.stroke(bar, with: .color(t.isDark ? .white.opacity(0.18) : .black.opacity(0.18)), lineWidth: 0.5)

            if w > 60 {
                let label = Text("#\(issue.number) \(issue.title)")
                    .font(.system(size: 10, weight: .medium)).foregroundColor(.white)
                ctx.draw(ctx.resolve(label), at: CGPoint(x: x + 8, y: y + h / 2), anchor: .leading)
            }

            if hoverIssueId == issue.id {
                ctx.stroke(bar, with: .color(t.text.opacity(0.6)), lineWidth: 1.5)
            }

            // Milestone diamond at the bar's end x-position, layered on top.
            if let dStr = issue.milestone?.dueDate, vm.parseDate(dStr) != nil {
                let cx = barRect.maxX
                let cy = y + h / 2
                let half: CGFloat = 4
                let diamond = Path { p in
                    p.move(to: CGPoint(x: cx, y: cy - half))
                    p.addLine(to: CGPoint(x: cx + half, y: cy))
                    p.addLine(to: CGPoint(x: cx, y: cy + half))
                    p.addLine(to: CGPoint(x: cx - half, y: cy))
                    p.closeSubpath()
                }
                ctx.fill(diamond, with: .color(t.warning))
                ctx.stroke(diamond, with: .color(t.isDark ? .black.opacity(0.4) : .white.opacity(0.6)), lineWidth: 0.5)
            }
        }

        // Dependency connectors (blocked-by): an elbow line from each blocker's
        // END to the dependent's START, with a small arrowhead at the dependent.
        // Both bars must be visible/dated (present in barRects); drawn last so
        // the lines sit above the bars. dependsOn comes from the schedule
        // overlay, so this is populated for GitHub (native GitLab has no links).
        let depColor = t.textMuted.opacity(0.55)
        for case let .issue(issue) in rows {
            guard let toRect = barRects[issue.number] else { continue }
            for depNumber in vm.dependencies(of: issue) {
                guard let fromRect = barRects[depNumber] else { continue }
                let start = CGPoint(x: fromRect.maxX, y: fromRect.midY)
                let end = CGPoint(x: toRect.minX, y: toRect.midY)
                let midX = end.x >= start.x ? (start.x + end.x) / 2 : start.x + 12
                let elbow = Path { p in
                    p.move(to: start)
                    p.addLine(to: CGPoint(x: midX, y: start.y))   // out from blocker
                    p.addLine(to: CGPoint(x: midX, y: end.y))     // vertical
                    p.addLine(to: end)                            // into dependent
                }
                ctx.stroke(elbow, with: .color(depColor), lineWidth: 1)
                // Arrowhead pointing right into the dependent's start edge.
                let ah: CGFloat = 4
                let arrow = Path { p in
                    p.move(to: CGPoint(x: end.x - ah, y: end.y - ah))
                    p.addLine(to: CGPoint(x: end.x, y: end.y))
                    p.addLine(to: CGPoint(x: end.x - ah, y: end.y + ah))
                }
                ctx.stroke(arrow, with: .color(depColor), lineWidth: 1)
            }
        }
    }

    // MARK: - Helpers

    private func isWeekend(_ d: Date, cal: Calendar) -> Bool {
        let w = cal.component(.weekday, from: d); return w == 1 || w == 7
    }

    private func isOverdue(_ issue: RepoIssue) -> Bool {
        guard issue.state == "opened" else { return false }
        // Overlay-aware bar end, not the native dueDate — matches the bar the
        // user sees and correctly flags GitHub overlay-scheduled issues.
        return vm.endDate(for: issue).map { $0 < Date() } ?? false
    }

    private func dayLabel(_ d: Date) -> String {
        AppDateFormatter.dayOfMonth(d)
    }

    private func weekdayLabel(_ d: Date, cal: Calendar) -> String {
        AppDateFormatter.weekdayAbbrev(d)
    }

    // MARK: - Segment helpers

    private struct Seg { let startDay: Int; let length: Int; let label: String }

    private func monthSegments(start: Date, days: Int, cal: Calendar, withYear: Bool) -> [Seg] {
        var segs: [Seg] = []; var i = 0
        while i < days {
            let d = cal.dayOffset(i, from: start)
            let comps = cal.dateComponents([.year, .month], from: d)
            var j = i + 1
            while j < days {
                let cj = cal.dateComponents([.year, .month], from: cal.dayOffset(j, from: start))
                if cj.year != comps.year || cj.month != comps.month { break }
                j += 1
            }
            let label = withYear ? AppDateFormatter.monthAndYear(d) : AppDateFormatter.monthAbbrev(d)
            segs.append(Seg(startDay: i, length: j - i, label: label))
            i = j
        }
        return segs
    }

    private func yearSegments(start: Date, days: Int, cal: Calendar) -> [Seg] {
        var segs: [Seg] = []; var i = 0
        while i < days {
            let d = cal.dayOffset(i, from: start)
            let year = cal.component(.year, from: d)
            var j = i + 1
            while j < days {
                if cal.component(.year, from: cal.dayOffset(j, from: start)) != year { break }
                j += 1
            }
            segs.append(Seg(startDay: i, length: j - i, label: AppDateFormatter.yearString(d)))
            i = j
        }
        return segs
    }
}
