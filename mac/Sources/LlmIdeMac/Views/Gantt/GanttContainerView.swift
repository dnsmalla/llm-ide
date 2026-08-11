// The Gantt tab's single entry point, for GitLab AND GitHub.
//
// There used to be two: this one (GitLab, rich chart) and RepoGanttView
// (GitHub, milestone bars only), with AppShell picking between them — so the
// view you got depended on which token you had configured. Now one coordinator
// resolves the backend through `RepoBackendFactory`, loads projects through the
// neutral `RepoBackend.listProjects()`, and hands both to the one `GanttView`.
//
// Provider-specific behaviour lives behind capability flags, not behind a
// second view: GitHub's missing issue dates are supplied by the
// /kb/issue-schedule overlay (see GanttViewModel), reached through `api`.

import SwiftUI

struct GanttContainerView: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    /// Server client for the scheduling overlay. Optional so previews and any
    /// legacy call site still compile — the overlay is simply skipped when nil.
    var api: LlmIdeAPIClient?

    @StateObject private var vm = GanttViewModel()

    @State private var activeBackend: RepoBackendKind?
    @State private var projects: [RepoProject] = []
    @State private var selectedProject: RepoProject?
    @State private var isLoadingProjects = false
    @State private var projectError: String?
    @State private var searchText = ""

    // MARK: - Backend resolution
    //
    // Mirrors RepoIssuesView so the Issues board and the Gantt always agree on
    // which provider is showing.

    private var availableBackends: [RepoBackendKind] {
        if let pref = config.preferredRepoProvider {
            if pref == .gitlab && !config.gitLabToken.isEmpty { return [.gitlab] }
            if pref == .github && !config.gitHubToken.isEmpty { return [.github] }
        }
        var out: [RepoBackendKind] = []
        if !config.gitLabToken.isEmpty { out.append(.gitlab) }
        if !config.gitHubToken.isEmpty { out.append(.github) }
        return out
    }

    private var defaultActiveBackend: RepoBackendKind {
        if let pref = config.preferredRepoProvider, availableBackends.contains(pref) { return pref }
        return availableBackends.first ?? .gitlab
    }

    private var effectiveBackend: RepoBackendKind { activeBackend ?? defaultActiveBackend }

    private var currentClient: RepoBackend {
        RepoBackendFactory.backend(for: effectiveBackend, config: config)
    }

    // MARK: - Body

    var body: some View {
        Group {
            if availableBackends.isEmpty {
                notConfigured
            } else if let project = selectedProject {
                GanttView(
                    vm: vm,
                    client: currentClient,
                    project: project,
                    api: api,
                    projects: projects,
                    onProjectChange: { p in
                        selectedProject = p
                        rememberProject(p)
                    },
                    backends: availableBackends,
                    onBackendChange: { switchBackend(to: $0) }
                )
            } else {
                projectPickerView(t: theme.current)
            }
        }
        .task(id: loadKey) { await loadProjects() }
    }

    /// Re-runs the project load when the backend changes AND when the set of
    /// configured providers changes. Keying on the backend alone left the view
    /// stuck on the "not configured" state after the user added a token in
    /// Settings and came back, since the resolved backend hadn't changed.
    private var loadKey: String {
        availableBackends.map(\.rawValue).joined(separator: ",") + "|" + effectiveBackend.rawValue
    }

    @ViewBuilder
    private var notConfigured: some View {
        // Same empty state as the Issues board — "No repository connected" was
        // shown even when the repo was saved and only the token had gone missing.
        let state = RepoConnectionEmptyState(config: config)
        EmptyStateView(
            icon: "lock.shield",
            title: state.title,
            message: state.message(surface: "a timeline"),
            actionLabel: "Open Settings",
            action: { NotificationCenter.default.post(name: .openSettings, object: nil) }
        )
    }

    // MARK: - Project picker

    @ViewBuilder
    private func projectPickerView(t: Theme) -> some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "chart.bar.doc.horizontal")
                    .font(.system(size: 28))
                    .foregroundStyle(t.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Gantt Chart")
                        .font(.title2.weight(.semibold))
                    Text("Select a \(effectiveBackend.displayName) project to view the timeline")
                        .font(.subheadline)
                        .foregroundStyle(t.textMuted)
                }
                Spacer()
                if availableBackends.count > 1 { backendPicker(t: t) }
            }
            .padding(.horizontal, 32)
            .padding(.top, 32)
            .padding(.bottom, 20)

            if isLoadingProjects {
                EmptyStateView(icon: "arrow.clockwise", title: "Loading projects…")
            } else if let err = projectError, projects.isEmpty {
                // Total failure (nothing resolved) — nothing useful to show
                // underneath, so this replaces the whole pane.
                EmptyStateView(
                    icon: "exclamationmark.triangle",
                    title: "Failed to load projects",
                    message: err,
                    actionLabel: "Retry",
                    action: { Task { await loadProjects(force: true) } },
                    iconColor: t.danger
                )
            } else if projects.isEmpty {
                EmptyStateView(
                    icon: "folder.badge.questionmark",
                    title: "No \(effectiveBackend.displayName) projects",
                    message: "Add a project in Settings → \(effectiveBackend.displayName) to chart its timeline.",
                    actionLabel: "Open Settings",
                    action: { NotificationCenter.default.post(name: .openSettings, object: nil) }
                )
            } else {
                // Search + project list. A partial-load error (some saved
                // projects resolved, others didn't) surfaces as a banner here
                // rather than hiding the projects that DID load.
                VStack(spacing: 0) {
                    if let err = projectError {
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
                            rememberProject(p)
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

    private func backendPicker(t: Theme) -> some View {
        HStack(spacing: 4) {
            ForEach(availableBackends, id: \.self) { backend in
                let active = backend == effectiveBackend
                Button {
                    if !active { switchBackend(to: backend) }
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

    private func switchBackend(to backend: RepoBackendKind) {
        guard backend != effectiveBackend else { return }
        projects = []
        selectedProject = nil
        projectError = nil
        vm.issues = []
        vm.milestones = []
        vm.schedules = [:]
        // Writing activeBackend changes `loadKey`, which is what re-runs the
        // project load — hence no explicit reload call here.
        activeBackend = backend
    }

    private func loadProjects(force: Bool = false) async {
        guard availableBackends.contains(effectiveBackend) else { return }
        if !force && !projects.isEmpty { return }   // already loaded — skip on tab re-visit
        isLoadingProjects = true
        projectError = nil
        defer { isLoadingProjects = false }
        do {
            let fetched = try await currentClient.listProjects()
            projects = fetched.sorted {
                $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending
            }
            if selectedProject == nil {
                selectedProject = lastUsedProject ?? projects.first
            }
        } catch {
            projectError = error.localizedDescription
        }
    }

    /// The project the user last charted on this backend, when it's still in
    /// the list — so re-opening the tab doesn't snap back to the first repo.
    private var lastUsedProject: RepoProject? {
        let remembered = effectiveBackend == .gitlab
            ? config.gitLabLastProjectId
            : config.gitHubLastRepoFullName
        guard !remembered.isEmpty else { return nil }
        return projects.first { $0.id == remembered || $0.fullName == remembered }
    }

    private func rememberProject(_ p: RepoProject) {
        switch effectiveBackend {
        case .gitlab: config.gitLabLastProjectId = p.id
        case .github: config.gitHubLastRepoFullName = p.fullName
        }
    }
}
