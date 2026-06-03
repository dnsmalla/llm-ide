import SwiftUI

/// Picker shown from `CodeWorkflowSheet` so users can run the multi-step
/// Review Code workflow against an already-open GitLab issue instead of
/// having to create a fresh one in the issue step.
struct ExistingIssuePicker: View {
    let project: SavedGitLabProject
    let onSelect: (GitLabIssue) -> Void
    let onCancel: () -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var theme: ThemeStore
    @State private var issues: [GitLabIssue] = []
    @State private var loading = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 520, height: 480)
        .task { await load() }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Pick an existing issue")
                    .font(.headline)
                Text(project.displayName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading open issues…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = errorMessage {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Text(err)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                Button("Retry") { Task { await load() } }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else if issues.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "tray")
                    .font(.title)
                    .foregroundStyle(.secondary)
                Text("No open issues")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(issues) { issue in
                Button {
                    onSelect(issue)
                    dismiss()
                } label: {
                    row(issue)
                }
                .buttonStyle(.plain)
            }
            .listStyle(.inset)
        }
    }

    private func row(_ issue: GitLabIssue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("#\(issue.iid)")
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text(issue.title)
                    .font(.callout)
                    .lineLimit(1)
                Spacer()
            }
            if !issue.labels.isEmpty {
                HStack(spacing: 4) {
                    ForEach(issue.labels.prefix(4), id: \.self) { lbl in
                        Text(lbl)
                            .font(.system(size: 10))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(theme.current.accent.opacity(0.12))
                            .foregroundStyle(theme.current.accent)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel") {
                onCancel()
                dismiss()
            }
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func load() async {
        guard let pid = project.resolvedId else {
            errorMessage = "Project has not been resolved on GitLab yet."
            return
        }
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            let filter = IssueFilter(state: .opened)
            let result = try await GitLabClient().listIssues(projectId: pid, filter: filter, page: 1)
            self.issues = result
        } catch {
            self.errorMessage = "Failed to load issues: \(error.localizedDescription)"
        }
    }
}
