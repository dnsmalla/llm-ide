import SwiftUI

/// Full-width Issues Board — mirrors the Gantt layout.
///
///  ┌─────────────────────────────────────────────────────────────────────┐
///  │  [Project ▾]    · · · · · ● Open N  ● Closed N   ↻   + New Issue   │  ← header bar
///  ├─────────────────────────────────────────────────────────────────────┤
///  │  [Search…]  All Open Closed  Milestone ▾  Label ▾  Assignee ▾  N/T  │  ← filter bar
///  ├─────────────────────────────────────────────────────────────────────┤
///  │                                                                     │
///  │   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                             │  ← kanban board
///  │   │ col  │ │ col  │ │ col  │ │ col  │  (horizontal scroll)        │
///  └─────────────────────────────────────────────────────────────────────┘
struct IssueBoardView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @State private var gitlab = GitLabClient()

    // Project
    @State private var projects: [GitLabProject] = []
    @State private var selectedProject: GitLabProject?
    @State private var projectsLoading = false

    // Filter
    @State private var filter = IssueFilter()

    // Issues
    @State private var issues: [GitLabIssue] = []
    @State private var issuesLoading = false
    @State private var issuesError: String?
    @State private var currentPage = 1
    @State private var hasMore = false

    // Labels + milestones
    @State private var labels: [GitLabLabel] = []
    @State private var milestones: [GitLabMilestone] = []
    @State private var members: [GitLabUser] = []

    // Selection → detail sheet
    @State private var selectedIssue: GitLabIssue?
    @State private var showingCreate = false

    // Debounce task for search input — avoids one API call per keystroke
    @State private var searchDebounce: Task<Void, Never>?

    private var isConfigured: Bool { !config.gitLabToken.isEmpty }

    // Counts from loaded issues (for the legend chips)
    private var openCount: Int   { issues.filter { $0.state != "closed" }.count }
    private var closedCount: Int { issues.filter { $0.state == "closed" }.count }

    var body: some View {
        Group {
            if !isConfigured {
                notConfiguredView
            } else {
                boardLayout
            }
        }
        .task { await initialLoad() }
        .onChange(of: config.gitLabToken)   { _, _ in projects = []; Task { await initialLoad() } }
        .onChange(of: config.gitLabBaseURL) { _, _ in projects = []; Task { await initialLoad() } }
        // Instant reload for dropdown filter changes
        .onChange(of: filter.state)       { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.milestoneId) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.labelName)   { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.assigneeId)  { _, _ in Task { await reloadIssues() } }
        // Debounced reload for search — waits 400 ms after user stops typing
        .onChange(of: filter.search) { _, _ in
            searchDebounce?.cancel()
            searchDebounce = Task {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                await reloadIssues()
            }
        }
        .sheet(isPresented: $showingCreate) {
            if let project = selectedProject {
                IssueCreateSheet(
                    gitlab: gitlab,
                    project: project,
                    labels: labels,
                    milestones: milestones,
                    members: members
                ) { newIssue in
                    issues.insert(newIssue, at: 0)
                    selectedIssue = newIssue
                }
                .environmentObject(theme)
            }
        }
        .sheet(item: $selectedIssue) { issue in
            issueDetailSheet(issue)
        }
    }

    // MARK: - Board layout

    private var boardLayout: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().background(theme.current.border)
            filterBar
            Divider().background(theme.current.border)
            boardBody
        }
        .background(theme.current.body)
    }

    // MARK: - Header bar (project + state counts + actions)

    private var headerBar: some View {
        let t = theme.current
        return HStack(spacing: 0) {
            // Project dropdown — fills available space, shows full name
            projectDropdown(t: t)

            Divider().frame(height: 20).padding(.horizontal, 14)

            // Open / Closed chips — toggle filter state
            stateChip(label: "Open",   count: openCount,   state: .opened, color: t.accent2, t: t)
            stateChip(label: "Closed", count: closedCount, state: .closed, color: t.accent3, t: t)

            Spacer(minLength: 0)

            if issuesLoading {
                ProgressView().controlSize(.small).scaleEffect(0.75)
            }

            Button { Task { await reloadIssues() } } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.textMuted)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2.opacity(0.8)))
            }
            .buttonStyle(.plain)
            .disabled(selectedProject == nil || issuesLoading)
            .help("Refresh  ⌘R")
            .accessibilityLabel("Refresh issues")
            .keyboardShortcut("r", modifiers: .command)
            .padding(.leading, 8)

            Button { showingCreate = true } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                    Text("New Issue").font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 13).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 8).fill(t.accent))
            }
            .buttonStyle(.plain)
            .disabled(selectedProject == nil)
            .help("New issue  ⌘⇧N")
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .padding(.leading, 10)
        }
        .padding(.horizontal, 20)
        .frame(height: 46)
        .background(t.surface)
    }

    @ViewBuilder
    private func projectDropdown(t: Theme) -> some View {
        Menu {
            if projectsLoading {
                Label("Loading projects…", systemImage: "arrow.clockwise")
            } else if projects.isEmpty {
                Label("No projects found", systemImage: "exclamationmark.triangle")
            } else {
                ForEach(projects) { p in
                    Button {
                        selectedProject = p
                        config.gitLabLastProjectId = "\(p.id)"
                        Task { await switchProject(p) }
                    } label: { Text(p.name) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                if let p = selectedProject {
                    Text(p.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(t.text)
                        .lineLimit(1)
                } else {
                    Text(projectsLoading ? "Loading…" : "Select a project")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(t.textMuted)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(t.textMuted)
            }
            .fixedSize()
        }
        .menuStyle(.borderlessButton)
        .frame(maxWidth: 280, alignment: .leading)
    }

    // State chip for the header bar (toggles filter.state)
    @ViewBuilder
    private func stateChip(
        label: String, count: Int,
        state: IssueFilter.IssueState, color: Color, t: Theme
    ) -> some View {
        let active = filter.state == state || filter.state == .all
        Button {
            filter.state = (filter.state == state) ? .all : state
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(active ? color : color.opacity(0.3))
                    .frame(width: 8, height: 8)
                Text(label)
                    .font(.system(size: 12, weight: active ? .semibold : .regular))
                    .foregroundStyle(active ? t.text : t.textMuted)
                Text("\(count)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(active ? color : t.textMuted)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(active ? color.opacity(0.12) : t.surface2.opacity(0.6)))
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7)
                .fill(active ? t.surface2.opacity(0.7) : Color.clear))
            .opacity(active ? 1 : 0.6)
        }
        .buttonStyle(.plain)
        .help("Filter: \(label.lowercased()) issues")
    }

    // MARK: - Filter bar (search + filter pills only)

    private var filterBar: some View {
        let t = theme.current
        return HStack(spacing: 0) {
            // Search — flexible width
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11)).foregroundStyle(t.textMuted)
                TextField("Search issues…", text: $filter.search)
                    .textFieldStyle(.plain).font(.system(size: 12))
                if !filter.search.isEmpty {
                    Button { filter.search = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 10)).foregroundStyle(t.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                    .help("Clear search")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2.opacity(0.8)))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(t.border.opacity(0.6), lineWidth: 1))
            .frame(minWidth: 180, maxWidth: 280)
            .padding(.leading, 16)

            tabDivider(t: t)

            // Milestone pill
            if !milestones.isEmpty {
                filterPillMenu(
                    icon: "flag",
                    label: milestoneLabel,
                    isActive: filter.milestoneId != nil,
                    t: t
                ) {
                    Button("Any milestone") { filter.milestoneId = nil }
                    Divider()
                    ForEach(milestones) { m in
                        Button {
                            filter.milestoneId = (filter.milestoneId == m.id) ? nil : m.id
                        } label: {
                            Label(m.title, systemImage: filter.milestoneId == m.id ? "checkmark" : "")
                        }
                    }
                }
            }

            // Label pill
            if !labels.isEmpty {
                filterPillMenu(
                    icon: "tag",
                    label: filter.labelName.isEmpty ? "Label" : filter.labelName,
                    isActive: !filter.labelName.isEmpty,
                    t: t
                ) {
                    Button("Any label") { filter.labelName = "" }
                    Divider()
                    ForEach(labels.prefix(20)) { lbl in
                        Button {
                            filter.labelName = (filter.labelName == lbl.name) ? "" : lbl.name
                        } label: {
                            Label(lbl.name, systemImage: filter.labelName == lbl.name ? "checkmark" : "")
                        }
                    }
                }
            }

            // Assignee pill
            if !members.isEmpty {
                filterPillMenu(
                    icon: "person",
                    label: assigneeLabel,
                    isActive: filter.assigneeId != nil,
                    t: t
                ) {
                    Button("Any assignee") { filter.assigneeId = nil }
                    Divider()
                    ForEach(members) { u in
                        Button {
                            filter.assigneeId = (filter.assigneeId == u.id) ? nil : u.id
                        } label: {
                            Label(u.name, systemImage: filter.assigneeId == u.id ? "checkmark" : "")
                        }
                    }
                }
            }

            Spacer(minLength: 0)

            // Clear filters
            if filter != IssueFilter() {
                Button { filter = IssueFilter() } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "xmark.circle").font(.system(size: 10))
                        Text("Clear").font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(t.danger)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 5).fill(t.danger.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .padding(.trailing, 10)
            }

            // Issue count
            if !issues.isEmpty || issuesLoading {
                Text("\(issues.count)\(hasMore ? "+" : "") issues")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .padding(.trailing, 20)
            }
        }
        .frame(height: 42)
        .background(t.body)
    }

    @ViewBuilder
    private func filterPillMenu<MenuItems: View>(
        icon: String, label: String, isActive: Bool, t: Theme,
        @ViewBuilder menuContent: () -> MenuItems
    ) -> some View {
        Menu { menuContent() } label: {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 10, weight: .medium))
                Text(label)
                    .font(.system(size: 12, weight: isActive ? .medium : .regular))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .foregroundStyle(isActive ? t.accent : t.textMuted)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? t.accent.opacity(0.08) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(isActive ? t.accent.opacity(0.35) : t.border.opacity(0.7), lineWidth: 1)
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .padding(.leading, 8)
    }

    private func tabDivider(t: Theme) -> some View {
        Rectangle()
            .fill(t.border.opacity(0.8))
            .frame(width: 1, height: 18)
            .padding(.horizontal, 12)
    }

    private var milestoneLabel: String {
        guard let id = filter.milestoneId,
              let m = milestones.first(where: { $0.id == id }) else { return "Milestone" }
        return m.title
    }

    private var assigneeLabel: String {
        guard let id = filter.assigneeId,
              let u = members.first(where: { $0.id == id }) else { return "Assignee" }
        return u.name
    }

    // MARK: - Board body

    @ViewBuilder
    private var boardBody: some View {
        if let err = issuesError {
            EmptyStateView(
                icon: "exclamationmark.triangle",
                title: "Failed to load issues",
                message: err,
                actionLabel: "Retry",
                action: { Task { await reloadIssues() } },
                iconColor: theme.current.danger
            )
        } else if selectedProject == nil && !projectsLoading {
            EmptyStateView(
                icon: "folder.badge.questionmark",
                title: "Select a project",
                message: "Choose a project from the dropdown above to view its issues."
            )
        } else if issuesLoading && issues.isEmpty {
            VStack(spacing: 10) {
                ProgressView()
                Text("Loading issues…")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            IssueKanbanPanel(
                issues: issues,
                selectedIssue: $selectedIssue,
                gitlab: gitlab,
                project: selectedProject,
                labels: labels,
                onIssueUpdate: { updated in
                    if let idx = issues.firstIndex(where: { $0.id == updated.id }) {
                        issues[idx] = updated
                    }
                }
            )
        }
    }

    // MARK: - Issue detail sheet

    @ViewBuilder
    private func issueDetailSheet(_ issue: GitLabIssue) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("#\(issue.iid) · \(issue.title)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.text)
                    .lineLimit(1)
                Spacer()
                Button { selectedIssue = nil } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(theme.current.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close issue detail")
                .help("Close")
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(theme.current.surface)

            Divider().background(theme.current.border)

            IssueDetailPanel(
                issue: issue,
                gitlab: gitlab,
                project: selectedProject,
                labels: labels,
                milestones: milestones,
                members: members,
                onUpdate: { updated in
                    if let idx = issues.firstIndex(where: { $0.id == updated.id }) {
                        issues[idx] = updated
                    }
                    selectedIssue = updated
                }
            )
        }
        .environmentObject(theme)
        .frame(minWidth: 740, minHeight: 560)
    }

    // MARK: - Not configured

    private var notConfiguredView: some View {
        // GitHub-configured users never reach this empty state —
        // AppShell.issuesRoute sends them to RepoIssuesView. The
        // hasGitHub branch that previously lived here was dead.
        EmptyStateView(
            icon: "lock.shield",
            title: "GitLab not connected",
            message: "Add your Personal Access Token in Settings → GitLab.\nThe token needs the **api** scope.",
            actionLabel: "Open Settings",
            action: { NotificationCenter.default.post(name: .openSettings, object: nil) }
        )
    }

    // MARK: - Data loading

    private func initialLoad() async {
        guard isConfigured else { return }
        guard projects.isEmpty else { return }  // already loaded — skip on tab re-visit
        projectsLoading = true
        defer { projectsLoading = false }
        do {
            let allSaved = config.gitLabSavedProjects
            if !allSaved.isEmpty {
                // Resolve any saved projects that don't have an ID yet
                for sp in allSaved where sp.resolvedId == nil && !sp.url.isEmpty {
                    if let project = try? await gitlab.resolveProject(rawURL: sp.url),
                       let idx = config.gitLabSavedProjects.firstIndex(where: { $0.id == sp.id }) {
                        config.gitLabSavedProjects[idx].resolvedId = project.id
                        if config.gitLabSavedProjects[idx].displayName.isEmpty {
                            config.gitLabSavedProjects[idx].displayName = project.name
                        }
                        // Update base URL from the project's host
                        if sp.url.hasPrefix("http"), let u = URL(string: sp.url),
                           let scheme = u.scheme, let host = u.host {
                            config.gitLabBaseURL = "\(scheme)://\(host)"
                        }
                    }
                }

                let resolved = config.gitLabSavedProjects.filter { $0.resolvedId != nil }
                guard !resolved.isEmpty else {
                    issuesError = "Could not resolve saved projects. Check the URLs in Settings → GitLab."
                    return
                }

                let loaded: [GitLabProject] = try await withThrowingTaskGroup(of: GitLabProject?.self) { group in
                    for sp in resolved {
                        group.addTask { try? await self.gitlab.getProject(id: sp.resolvedId!) }
                    }
                    var result: [GitLabProject] = []
                    for try await p in group { if let p { result.append(p) } }
                    return result
                }
                projects = resolved.compactMap { sp in loaded.first { $0.id == sp.resolvedId } }
                let activeId = config.gitLabActiveProjectId
                if let activeId, let match = projects.first(where: { $0.id == activeId }) {
                    selectedProject = match
                    await switchProject(match)
                } else if let first = projects.first {
                    selectedProject = first
                    await switchProject(first)
                }
            } else {
                // No saved projects configured — list all
                projects = try await gitlab.listProjects()
                if !config.gitLabLastProjectId.isEmpty,
                   let id = Int(config.gitLabLastProjectId),
                   let match = projects.first(where: { $0.id == id }) {
                    selectedProject = match
                    await switchProject(match)
                }
            }
        } catch {
            issuesError = error.localizedDescription
        }
    }

    private func switchProject(_ project: GitLabProject) async {
        config.gitLabLastProjectId = "\(project.id)"
        selectedIssue = nil
        issues = []
        currentPage = 1
        async let labelsTask   = (try? await gitlab.listLabels(projectId: project.id))     ?? []
        async let milesTask    = (try? await gitlab.listMilestones(projectId: project.id)) ?? []
        async let membersTask  = (try? await gitlab.listMembers(projectId: project.id))    ?? []
        let (l, m, mem) = await (labelsTask, milesTask, membersTask)
        labels    = l
        milestones = m
        members   = mem
        await reloadIssues()
    }

    private func reloadIssues() async {
        guard let project = selectedProject else { return }
        currentPage   = 1
        issuesLoading = true
        issuesError   = nil
        defer { issuesLoading = false }
        do {
            let batch = try await gitlab.listIssues(projectId: project.id, filter: filter, page: 1)
            issues  = batch
            hasMore = batch.count == 50
        } catch {
            issuesError = error.localizedDescription
        }
    }
}

