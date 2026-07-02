// Shared project picker for backend-agnostic views (RepoIssuesView,
// RepoGanttView, future ones). Replaces the near-identical
// `projectDropdown` blocks that previously lived in each view.

import SwiftUI

struct RepoProjectDropdown: View {
    let projects: [RepoProject]
    @Binding var selected: RepoProject?
    let isLoading: Bool
    let backendDisplayName: String
    /// Fired after the binding updates so the host view can kick off a
    /// reload (issues, milestones, etc.). The new selection is passed
    /// through for convenience even though the binding has already
    /// been written by the time this runs.
    var onSelect: (RepoProject) -> Void

    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let t = theme.current
        Menu {
            if isLoading {
                Label("Loading…", systemImage: "arrow.clockwise")
            } else if projects.isEmpty {
                Label("No \(backendDisplayName) projects", systemImage: "exclamationmark.triangle")
            } else {
                ForEach(projects) { p in
                    Button {
                        selected = p
                        onSelect(p)
                    } label: { Text(p.name) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                if let p = selected {
                    Text(p.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(t.text)
                        .lineLimit(1)
                } else {
                    Text(isLoading ? "Loading…" : "Select a project")
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
}
