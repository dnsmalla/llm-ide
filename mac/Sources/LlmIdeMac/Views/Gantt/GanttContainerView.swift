import SwiftUI

/// Coordinator that owns the project picker, then renders the full Gantt chart
/// once a project is selected. Currently supports GitLab projects only.
struct GanttContainerView: View {
    @EnvironmentObject var theme: ThemeStore
    @StateObject private var vm = GanttViewModel()

    private let gitlab = GitLabClient()
    private let config  = AppConfig.shared

    @State private var projects: [GitLabProject] = []
    @State private var selectedProject: GitLabProject?
    @State private var isLoadingProjects = false
    @State private var projectError: String?
    @State private var searchText = ""

    var body: some View {
        let t = theme.current
        if let project = selectedProject {
            GanttView(
                vm: vm,
                gitlab: gitlab,
                project: project,
                projects: projects,
                onProjectChange: { p in
                    selectedProject = p
                    config.gitLabLastProjectId = "\(p.id)"
                }
            )
        } else {
            projectPickerView(t: t)
                .task { await loadProjects() }
        }
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
            }
            .padding(.horizontal, 32)
            .padding(.top, 32)
            .padding(.bottom, 20)

            if config.gitLabToken.isEmpty {
                let hasGitHub = !config.gitHubToken.isEmpty
                EmptyStateView(
                    icon: hasGitHub ? "rectangle.connected.to.line.below" : "key.slash",
                    title: hasGitHub ? "Gantt requires GitLab" : "GitLab not configured",
                    message: hasGitHub
                        ? "You have GitHub configured, but Gantt currently only supports GitLab projects for timeline planning. Add a GitLab PAT in Settings → GitLab to use this view."
                        : "Add your Personal Access Token in Settings → GitLab to connect.",
                    actionLabel: "Open Settings",
                    action: { NotificationCenter.default.post(name: .openSettings, object: nil) }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if isLoadingProjects {
                EmptyStateView(icon: "arrow.clockwise", title: "Loading projects…")
            } else if let err = projectError, projects.isEmpty {
                // Total failure (nothing resolved) — nothing useful to show
                // underneath, so this replaces the whole pane.
                EmptyStateView(
                    icon: "exclamationmark.triangle",
                    title: "Failed to load projects",
                    message: err,
                    actionLabel: "Retry",
                    action: { Task { await loadProjects() } },
                    iconColor: t.danger
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
                            config.gitLabLastProjectId = "\(p.id)"
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.name)
                                    .font(.body.weight(.medium))
                                Text(p.nameWithNamespace)
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

    private var filteredProjects: [GitLabProject] {
        guard !searchText.isEmpty else { return projects }
        let q = searchText.lowercased()
        return projects.filter { $0.nameWithNamespace.lowercased().contains(q) }
    }

    // MARK: - Load

    private func loadProjects() async {
        guard !config.gitLabToken.isEmpty else { return }
        guard projects.isEmpty else { return }  // already loaded — skip on tab re-visit
        isLoadingProjects = true
        projectError = nil
        defer { isLoadingProjects = false }
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
                        if sp.url.hasPrefix("http"), let u = URL(string: sp.url),
                           let scheme = u.scheme, let host = u.host {
                            config.gitLabBaseURL = "\(scheme)://\(host)"
                        }
                    }
                }

                let resolved = config.gitLabSavedProjects.filter { $0.resolvedId != nil }
                guard !resolved.isEmpty else {
                    projectError = "Could not resolve saved projects. Check the URLs in Settings → GitLab."
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
                // Each getProject() failure is swallowed above (`try?`) so a
                // single 404/network blip doesn't blank the whole list — but
                // surface the gap instead of letting a saved project vanish
                // with no explanation.
                if projects.count < resolved.count {
                    let missing = resolved.count - projects.count
                    projectError = "Loaded \(projects.count) of \(resolved.count) saved projects — \(missing) failed to load."
                }
                let activeId = config.gitLabActiveProjectId
                if let activeId, let match = projects.first(where: { $0.id == activeId }) {
                    selectedProject = match
                } else {
                    selectedProject = projects.first
                }
            } else {
                // No saved projects configured — list all
                projects = try await gitlab.listProjects()
                if selectedProject == nil, let lastId = Int(config.gitLabLastProjectId),
                   let match = projects.first(where: { $0.id == lastId }) {
                    selectedProject = match
                }
            }
        } catch {
            projectError = error.localizedDescription
        }
    }
}
