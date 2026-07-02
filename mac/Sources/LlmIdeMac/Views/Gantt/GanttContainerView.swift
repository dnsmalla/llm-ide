import SwiftUI

/// Coordinator that owns the backend/project picker, then renders the full
/// Gantt chart once a project is selected. Mirrors RepoIssuesView's
/// provider/project handling so both GitLab (native dates) and GitHub
/// (scheduling overlay) render through the same rich chart.
struct GanttContainerView: View {
    var api: LlmIdeAPIClient? = nil

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @StateObject private var vm = GanttViewModel()

    // ── Backend selection
    @State private var activeBackend: RepoBackendKind = .gitlab

    // ── Project state (per backend)
    @State private var projects: [RepoProject] = []
    @State private var selectedProject: RepoProject?
    @State private var projectsLoading = false
    @State private var projectsError: String?
    @State private var searchText = ""

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
        mainContent
    }

    @ViewBuilder
    private var mainContent: some View {
        Group {
            if availableBackends.isEmpty {
                notConfigured
            } else if let project = selectedProject {
                GanttView(
                    vm: vm,
                    backend: currentClient,
                    project: project,
                    projects: projects,
                    onProjectChange: { p in selectedProject = p },
                    api: api
                )
            } else {
                projectPickerView(t: theme.current)
            }
        }
        .task { await initialLoad() }
        .onChange(of: activeBackend) { _, _ in Task { await switchBackend() } }
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

    // MARK: - Project picker

    @ViewBuilder
    private func projectPickerView(t: Theme) -> some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Image(systemName: "chart.bar.doc.horizontal")
                    .font(.system(size: 28))
                    .foregroundStyle(t.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Gantt Chart")
                        .font(.title2.weight(.semibold))
                    Text("Select a project to view the timeline")
                        .font(.subheadline)
                        .foregroundStyle(t.textMuted)
                }
                Spacer()
                if availableBackends.count > 1 {
                    backendPicker
                }
            }
            .padding(.horizontal, 32)
            .padding(.top, 32)
            .padding(.bottom, 20)

            if projectsLoading {
                EmptyStateView(icon: "arrow.clockwise", title: "Loading projects…")
            } else if let err = projectsError, projects.isEmpty {
                EmptyStateView(
                    icon: "exclamationmark.triangle",
                    title: "Failed to load projects",
                    message: err,
                    actionLabel: "Retry",
                    action: { Task { await loadProjects() } },
                    iconColor: t.danger
                )
            } else if projects.isEmpty {
                EmptyStateView(
                    icon: "calendar.badge.exclamationmark",
                    title: "No projects found",
                    message: "No \(activeBackend.displayName) projects are available for this account."
                )
            } else {
                VStack(spacing: 0) {
                    if let err = projectsError {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(t.danger)
                            Text(err).font(.caption).foregroundStyle(t.textMuted)
                            Spacer()
                        }
                        .padding(.horizontal, 32)
                        .padding(.bottom, 8)
                    }
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(t.textMuted)
                        TextField("Search projects…", text: $searchText)
                            .textFieldStyle(.plain)
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(t.surface2))
                    .padding(.horizontal, 32)
                    .padding(.bottom, 12)

                    Divider()

                    List(filteredProjects) { p in
                        Button {
                            selectedProject = p
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.name)
                                    .font(.body.weight(.medium))
                                Text(p.fullName)
                                    .font(.caption)
                                    .foregroundStyle(t.textMuted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(t.body)
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

    private var filteredProjects: [RepoProject] {
        guard !searchText.isEmpty else { return projects }
        let q = searchText.lowercased()
        return projects.filter { $0.fullName.lowercased().contains(q) }
    }

    // MARK: - Load

    private func initialLoad() async {
        // Pick the most useful default: if only GitHub is set up, jump
        // straight to it; otherwise prefer GitLab (legacy default).
        if availableBackends == [.github] { activeBackend = .github }
        else if !availableBackends.contains(activeBackend) {
            activeBackend = availableBackends.first ?? .gitlab
        }
        await switchBackend()
    }

    private func switchBackend() async {
        projects = []
        selectedProject = nil
        await loadProjects()
    }

    private func loadProjects() async {
        guard availableBackends.contains(activeBackend) else { return }
        guard projects.isEmpty else { return }  // already loaded — skip on tab re-visit
        projectsLoading = true
        projectsError = nil
        defer { projectsLoading = false }
        do {
            let fetched = try await currentClient.listProjects()
            projects = fetched.sorted {
                $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending
            }
            if selectedProject == nil { selectedProject = projects.first }
        } catch {
            projectsError = error.localizedDescription
        }
    }
}
