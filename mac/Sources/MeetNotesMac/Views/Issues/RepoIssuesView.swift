// Backend-agnostic issues view. Picks a RepoBackend (GitLab or GitHub)
// from the user's saved projects, lists issues through the neutral
// RepoBackend protocol, and surfaces a backend toggle when both
// providers are configured.
//
// Scope: read-only. Open / Closed filter, search, label filter, and
// click-to-open-on-web. Write paths (create, comment, close, MRs / PRs)
// stay in the dedicated GitLab IssueBoardView for now — that view still
// owns the full write surface against GitLab. If the user only has
// GitHub configured, AppShell routes to this view; if only GitLab, it
// routes to IssueBoardView; if both, the user can toggle.

import SwiftUI

struct RepoIssuesView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    // ── Backend selection
    @State private var activeBackend: RepoBackendKind = .gitlab

    // ── Project state (per backend)
    @State private var projects: [RepoProject] = []
    @State private var selectedProject: RepoProject?
    @State private var projectsLoading = false
    @State private var projectsError: String?

    // ── Issue state
    @State private var issues: [RepoIssue] = []
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
    @State private var rowBusy: Set<Int> = []     // numbers currently being patched

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
        .onChange(of: filter.state) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.labelName) { _, _ in Task { await reloadIssues() } }
        .onChange(of: filter.search) { _, _ in
            searchDebounce?.cancel()
            searchDebounce = Task {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                await reloadIssues()
            }
        }
        .sheet(isPresented: $showCompose) { composeSheet }
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

    // MARK: - Row actions

    private func toggleState(of issue: RepoIssue) async {
        guard let project = selectedProject else { return }
        rowBusy.insert(issue.number)
        defer { rowBusy.remove(issue.number) }
        do {
            let change: RepoIssuePayload.StateChange = issue.isOpen ? .close : .reopen
            let updated = try await currentClient.updateIssue(
                projectId: project.id, number: issue.number,
                payload: RepoIssuePayload(stateChange: change))
            if let i = issues.firstIndex(where: { $0.id == updated.id }) {
                // Drop the row from the list if the filter excludes its new state.
                let stillFits: Bool = {
                    switch filter.state {
                    case .all:    return true
                    case .opened: return updated.isOpen
                    case .closed: return !updated.isOpen
                    }
                }()
                if stillFits { issues[i] = updated } else { issues.remove(at: i) }
            }
        } catch {
            issuesError = error.localizedDescription
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
                .disabled(selectedProject == nil)
                .help("Create issue  ⌘⇧N")
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
            Spacer()
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
        .background(t.surface.opacity(0.6))
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
            ScrollView {
                LazyVStack(spacing: Spacing.xs) {
                    ForEach(issues) { issue in
                        issueRow(issue)
                            .padding(.horizontal, Spacing.lg)
                    }
                }
                .padding(.vertical, Spacing.sm)
            }
        }
    }

    @ViewBuilder
    private func issueRow(_ issue: RepoIssue) -> some View {
        let t = theme.current
        let busy = rowBusy.contains(issue.number)
        Button {
            // Single click → inline detail sheet (comments + close/reopen).
            // ⌘-click or "Open on web" context-menu item opens the
            // provider's web UI instead.
            detailIssue = issue
        } label: {
            HStack(alignment: .top, spacing: Spacing.md) {
                Circle()
                    .fill(issue.isOpen ? t.accent3 : t.textMuted.opacity(0.5))
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text("#\(issue.number)")
                            .font(Typography.mono).foregroundStyle(t.textMuted)
                        Text(issue.title)
                            .font(Typography.bodyStrong)
                            .foregroundStyle(t.text)
                            .lineLimit(1).truncationMode(.tail)
                        if !issue.isOpen {
                            Text("CLOSED")
                                .font(.system(size: 9, weight: .heavy, design: .rounded))
                                .foregroundStyle(t.textMuted)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(t.surface2))
                        }
                    }
                    HStack(spacing: 8) {
                        Text(issue.author.displayName)
                            .font(Typography.caption).foregroundStyle(t.textMuted)
                        if issue.commentCount > 0 {
                            Label("\(issue.commentCount)", systemImage: "bubble.left")
                                .font(Typography.caption).foregroundStyle(t.textMuted)
                                .labelStyle(.titleAndIcon)
                        }
                        ForEach(issue.labels.prefix(4), id: \.self) { name in
                            Text(name)
                                .font(.system(size: 9, weight: .semibold))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(t.surface2))
                                .foregroundStyle(t.textMuted)
                        }
                    }
                }
                Spacer()
                if busy {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                }
            }
            .padding(Spacing.md)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(t.border, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .help(issue.title)
        .contextMenu {
            Button { detailIssue = issue } label: {
                Label("View details", systemImage: "doc.text")
            }
            Button {
                if let url = URL(string: issue.webUrl) { NSWorkspace.shared.open(url) }
            } label: {
                Label("Open on \(activeBackend.displayName)", systemImage: "arrow.up.right.square")
            }
            if currentClient.canWriteIssues {
                Divider()
                if issue.isOpen {
                    Button { Task { await toggleState(of: issue) } } label: {
                        Label("Close issue", systemImage: "xmark.circle")
                    }
                } else {
                    Button { Task { await toggleState(of: issue) } } label: {
                        Label("Reopen issue", systemImage: "arrow.counterclockwise.circle")
                    }
                }
            }
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
        do {
            issues = try await currentClient.listIssues(projectId: project.id, filter: filter, page: 1)
        } catch {
            issuesError = error.localizedDescription
        }
    }
}
