// Backend-agnostic issue BOARD. Picks a RepoBackend (GitLab or GitHub) from
// the user's saved projects and renders a kanban (RepoKanbanPanel) whose
// columns are derived from labels — the most common label namespace becomes
// the columns, falling back to Open / Closed. This gives GitHub the same board
// experience as the GitLab-only IssueBoardView. Drag a card to move it
// (rewrites the status label or toggles state); tap to open the detail sheet.
//
// Scope: read + write for BOTH backends — search, state filter, New Issue
// (compose sheet), and drag-to-move, all gated on `canWriteIssues`. GitLab-
// only affordances (weight, MR creation UI) are gated via capability flags.
// AppShell routes all providers here; the provider switch lets dual-configured
// users choose.

import SwiftUI

struct RepoIssuesView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    /// API client for the schedule overlay (GitHub due-date editing). Optional
    /// so existing call sites that don't pass it still compile; the schedule
    /// editor button in the detail sheet is simply hidden when nil.
    var api: LlmIdeAPIClient? = nil

    // ── Backend selection
    @State private var activeBackend: RepoBackendKind = .gitlab

    // ── Project state (per backend)
    @State private var projects: [RepoProject] = []
    @State private var selectedProject: RepoProject?
    @State private var projectsLoading = false
    @State private var projectsError: String?

    // ── Issue state
    @State private var issues: [RepoIssue] = []
    @State private var labels: [RepoLabel] = []     // for board column colors
    @State private var milestones: [RepoMilestone] = []
    @State private var issuesLoading = false
    @State private var issuesError: String?

    // ── Filter
    @State private var filter = RepoIssueFilter()
    @State private var searchDebounce: Task<Void, Never>?

    // ── Write affordances (Phase 2)
    @State private var showCompose = false
    @State private var composeTitle = ""
    @State private var composeBody = ""
    @State private var composeBusy = false
    @State private var composeError: String?
    @State private var detailIssue: RepoIssue?

    private var availableBackends: [RepoBackendKind] {
        var out: [RepoBackendKind] = []
        if !config.gitLabToken.isEmpty { out.append(.gitlab) }
        if !config.gitHubToken.isEmpty { out.append(.github) }
        return out
    }

    private var currentClient: RepoBackend {
        switch activeBackend {
        case .gitlab: return RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
        case .github: return RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
        }
    }

    var body: some View {
        mainContent
            .sheet(isPresented: $showCompose) { composeSheet }
            .sheet(item: $detailIssue) { issue in
                RepoIssueDetailSheet(
                    issue: issue,
                    client: currentClient,
                    projectId: selectedProject?.id ?? "",
                    projectFullName: selectedProject?.fullName ?? "",
                    api: api,
                    onIssueChanged: { updated in
                        if let i = issues.firstIndex(where: { $0.id == updated.id }) {
                            issues[i] = updated
                        }
                    },
                    onDismiss: { detailIssue = nil }
                )
            }
    }

    /// Intermediate view: root Group + lifecycle/filter observers.
    /// Extracted so `body` is a short two-modifier composition and the
    /// SwiftUI type-checker never has to infer a single 8-modifier chain.
    @ViewBuilder
    private var mainContent: some View {
        Group {
            if availableBackends.isEmpty {
                notConfigured
            } else {
                content
            }
        }
        .task { await initialLoad() }
        .onChange(of: activeBackend) { _, _ in Task { await switchBackend() } }
        .onChange(of: filter.state) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.labelName) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.assigneeId) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.milestoneId) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.search) { _, _ in
            searchDebounce?.cancel()
            searchDebounce = Task {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                await reloadIssues()
            }
        }
    }

    // MARK: - Compose sheet

    @ViewBuilder
    private var composeSheet: some View {
        let t = theme.current
        let canSubmit = !composeTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && !composeBusy

        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("New Issue").font(Typography.title).foregroundStyle(t.text)
                Spacer()
                if let project = selectedProject {
                    Text(project.fullName).font(Typography.caption).foregroundStyle(t.textMuted)
                }
            }
            TextField("Title", text: $composeTitle)
                .textFieldStyle(.roundedBorder)
                .font(Typography.body)
            TextEditor(text: $composeBody)
                .font(Typography.body)
                .frame(minHeight: 140, maxHeight: 280)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            if let err = composeError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption).foregroundStyle(t.danger)
            }
            HStack {
                Spacer()
                Button("Cancel") { showCompose = false }
                    .buttonStyle(.bordered)
                    .controlSize(.regular)
                    .disabled(composeBusy)
                Button(composeBusy ? "Creating…" : "Create") {
                    Task { await submitCompose() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .disabled(!canSubmit)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 520, idealWidth: 560, minHeight: 320)
    }

    private func submitCompose() async {
        guard let project = selectedProject else { return }
        let title = composeTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        composeBusy = true; composeError = nil
        defer { composeBusy = false }
        do {
            let payload = RepoIssuePayload(title: title, body: composeBody.isEmpty ? nil : composeBody)
            let created = try await currentClient.createIssue(projectId: project.id, payload: payload)
            issues.insert(created, at: 0)
            showCompose = false
        } catch {
            composeError = error.localizedDescription
        }
    }

    // MARK: - Layout

    private var content: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().background(theme.current.border)
            filterBar
            Divider().background(theme.current.border)
            issuesList
        }
        .background(theme.current.body)
    }

    @ViewBuilder
    private var notConfigured: some View {
        EmptyStateView(
            icon: "lock.shield",
            title: "No repository connected",
            message: "Add a GitLab or GitHub Personal Access Token in Settings to start browsing issues.",
            actionLabel: "Open Settings",
            action: { NotificationCenter.default.post(name: .openSettings, object: nil) }
        )
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
            Spacer(minLength: 0)
            if issuesLoading || projectsLoading {
                ProgressView().controlSize(.small).scaleEffect(0.75).padding(.trailing, 8)
            }
            Button {
                Task { await reloadIssues() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.textMuted)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2.opacity(0.8)))
            }
            .buttonStyle(.plain)
            .disabled(selectedProject == nil || issuesLoading)
            .help("Refresh  ⌘R")
            .keyboardShortcut("r", modifiers: .command)
            .padding(.leading, 8)

            if currentClient.canWriteIssues {
                Button {
                    composeTitle = ""; composeBody = ""; composeError = nil
                    showCompose = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                        Text("New Issue").font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 13).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 8).fill(t.accent))
                }
                .buttonStyle(.plain)
                .disabled(selectedProject == nil || !config.isAllowed(.createIssue, provider: activeBackend))
                .help(config.isAllowed(.createIssue, provider: activeBackend)
                      ? "Create issue  ⌘⇧N"
                      : "Enable Create issue in Settings → \(activeBackend.displayName) → Automation & Actions")
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .padding(.leading, 10)
            }
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
                .help("Switch to \(backend.displayName)")
            }
        }
    }

    private var projectDropdown: some View {
        RepoProjectDropdown(
            projects: projects,
            selected: $selectedProject,
            isLoading: projectsLoading,
            backendDisplayName: activeBackend.displayName,
            onSelect: { _ in Task { await reloadIssues() } }
        )
    }

    // MARK: - Filter

    private var filterBar: some View {
        let t = theme.current
        return HStack(spacing: Spacing.sm) {
            // Search
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(t.textMuted)
                TextField("Search title / body", text: $filter.search)
                    .textFieldStyle(.plain)
                    .font(Typography.body)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2.opacity(0.6)))
            .frame(maxWidth: 280)

            // State chips
            ForEach(RepoIssueFilter.IssueState.allCases) { state in
                stateChip(state)
            }

            // Milestone filter — shown whenever milestones were loaded
            if !milestones.isEmpty {
                milestoneMenu(t: t)
            }
            // Label + Assignee filters — fast narrowing by tag / owner.
            if !labels.isEmpty {
                labelMenu(t: t)
            }
            if !availableAssignees.isEmpty {
                assigneeMenu(t: t)
            }

            Spacer()
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
        .background(t.surface.opacity(0.6))
    }

    @ViewBuilder
    private func milestoneMenu(t: Theme) -> some View {
        let activeMilestone = milestones.first(where: { $0.id == filter.milestoneId })
        let label = activeMilestone?.title ?? "Milestone"
        let isActive = filter.milestoneId != nil
        Menu {
            Button("Any milestone") { filter.milestoneId = nil }
            Divider()
            ForEach(milestones) { m in
                Button {
                    filter.milestoneId = (filter.milestoneId == m.id) ? nil : m.id
                } label: {
                    Label(m.title, systemImage: filter.milestoneId == m.id ? "checkmark" : "")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "flag").font(.system(size: 10, weight: .medium))
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

    /// Distinct assignees across the loaded issues, for the Assignee filter.
    private var availableAssignees: [RepoUser] {
        var seen = Set<String>(); var out: [RepoUser] = []
        for i in issues { for u in i.assignees where seen.insert(u.id).inserted { out.append(u) } }
        return out.sorted {
            assigneeName($0).localizedCaseInsensitiveCompare(assigneeName($1)) == .orderedAscending
        }
    }
    private func assigneeName(_ u: RepoUser) -> String { u.displayName.isEmpty ? u.username : u.displayName }

    @ViewBuilder
    private func labelMenu(t: Theme) -> some View {
        let isActive = !filter.labelName.isEmpty
        Menu {
            Button("Any label") { filter.labelName = "" }
            Divider()
            ForEach(labels) { l in
                Button {
                    filter.labelName = (filter.labelName == l.name) ? "" : l.name
                } label: {
                    Label(l.name, systemImage: filter.labelName == l.name ? "checkmark" : "")
                }
            }
        } label: {
            filterPillLabel(icon: "tag", text: isActive ? filter.labelName : "Label", isActive: isActive, t: t)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .padding(.leading, 8)
    }

    @ViewBuilder
    private func assigneeMenu(t: Theme) -> some View {
        let active = availableAssignees.first { $0.id == filter.assigneeId }
        let isActive = filter.assigneeId != nil
        Menu {
            Button("Any assignee") { filter.assigneeId = nil }
            Divider()
            ForEach(availableAssignees) { u in
                Button {
                    filter.assigneeId = (filter.assigneeId == u.id) ? nil : u.id
                } label: {
                    Label(assigneeName(u), systemImage: filter.assigneeId == u.id ? "checkmark" : "")
                }
            }
        } label: {
            filterPillLabel(icon: "person", text: active.map(assigneeName) ?? "Assignee", isActive: isActive, t: t)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .padding(.leading, 8)
    }

    /// Shared pill label for the Label / Assignee filter menus (mirrors the
    /// inline style of `milestoneMenu`).
    private func filterPillLabel(icon: String, text: String, isActive: Bool, t: Theme) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 10, weight: .medium))
            Text(text).font(.system(size: 12, weight: isActive ? .medium : .regular)).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
        }
        .foregroundStyle(isActive ? t.accent : t.textMuted)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(isActive ? t.accent.opacity(0.08) : Color.clear))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(isActive ? t.accent.opacity(0.35) : t.border.opacity(0.7), lineWidth: 1))
    }

    @ViewBuilder
    private func stateChip(_ state: RepoIssueFilter.IssueState) -> some View {
        let t = theme.current
        let active = filter.state == state
        Button {
            filter.state = state
        } label: {
            Text(state.displayName)
                .font(.system(size: 12, weight: active ? .semibold : .regular))
                .foregroundStyle(active ? t.text : t.textMuted)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7)
                    .fill(active ? t.surface2.opacity(0.7) : Color.clear))
        }
        .buttonStyle(.plain)
    }

    // MARK: - List

    @ViewBuilder
    private var issuesList: some View {
        let t = theme.current
        if let err = issuesError {
            EmptyStateView(icon: "exclamationmark.triangle",
                           title: "Failed to load issues",
                           message: err,
                           actionLabel: "Retry",
                           action: { Task { await reloadIssues() } },
                           iconColor: t.danger)
        } else if selectedProject == nil {
            EmptyStateView(icon: "list.bullet.rectangle",
                           title: "Pick a project",
                           message: "Choose one of your saved \(activeBackend.displayName) projects to list its issues.")
        } else if issues.isEmpty, !issuesLoading {
            EmptyStateView(icon: "tray",
                           title: "No issues",
                           message: "Nothing matches the current filter.")
        } else {
            // Kanban board — columns derived from labels (status namespace),
            // falling back to Open / Closed. Same experience for GitLab and
            // GitHub; drag a card to move it (rewrites the status label or
            // toggles state). Tapping a card opens the detail sheet.
            RepoKanbanPanel(
                issues: issues,
                labels: labels,
                backend: activeBackend,
                client: currentClient,
                projectId: selectedProject?.id ?? "",
                onSelect: { detailIssue = $0 },
                onIssueUpdate: { updated in
                    if let i = issues.firstIndex(where: { $0.id == updated.id }) {
                        // Drop the card if its new state no longer matches the filter.
                        let stillFits: Bool = {
                            switch filter.state {
                            case .all:    return true
                            case .opened: return updated.isOpen
                            case .closed: return !updated.isOpen
                            }
                        }()
                        if stillFits { issues[i] = updated } else { issues.remove(at: i) }
                    }
                }
            )
        }
    }

    // MARK: - Data

    private func initialLoad() async {
        // Pick the most useful default: if only one backend is set up,
        // jump straight to it; otherwise prefer GitLab (legacy default).
        if availableBackends == [.github] { activeBackend = .github }
        else if !availableBackends.contains(activeBackend) {
            activeBackend = availableBackends.first ?? .gitlab
        }
        await switchBackend()
    }

    private func switchBackend() async {
        projects = []
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
            // Auto-select the only / most-recent project.
            if selectedProject == nil { selectedProject = projects.first }
            await reloadIssues()
        } catch {
            projectsError = error.localizedDescription
        }
    }

    private func reloadIssues() async {
        guard let project = selectedProject else { return }
        issuesLoading = true
        issuesError = nil
        defer { issuesLoading = false }
        // Refresh labels for the board's column colors and milestones for the
        // milestone filter (best-effort — failures only affect the filter UI).
        labels = (try? await currentClient.listLabels(projectId: project.id)) ?? []
        milestones = (try? await currentClient.listMilestones(projectId: project.id)) ?? []
        do {
            // Page through results instead of stopping at page 1 — large
            // repos were silently truncated to a single backend page
            // (GitHub 50 / GitLab 100). Dedup by id and cap pages so a
            // backend that clamps an out-of-range page can't loop forever.
            var all: [RepoIssue] = []
            var seen = Set<String>()
            let maxPages = 20
            for page in 1...maxPages {
                let batch = try await currentClient.listIssues(projectId: project.id, filter: filter, page: page)
                let fresh = batch.filter { seen.insert($0.id).inserted }
                if fresh.isEmpty { break }   // empty page or repeated content → done
                all.append(contentsOf: fresh)
            }
            issues = all
        } catch {
            issuesError = error.localizedDescription
        }
    }
}
