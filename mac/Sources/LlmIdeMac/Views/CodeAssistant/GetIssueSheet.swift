import SwiftUI

/// Shared by GetIssueSheet and ListIssuesSheet — the two issue-detail
/// surfaces that render a RepoIssue's state as a colored pill.
extension RepoIssue {
    var stateColor: Color {
        switch state.lowercased() {
        case "opened": return .green
        case "closed": return .red
        default: return .secondary
        }
    }
}

/// Sheet for reading full issue details
struct GetIssueSheet: View {
    let iid: Int
    let projectId: String
    let providerKind: RepoBackendKind
    let onConfirm: () -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore
    @State private var isLoading = false
    @State private var issue: RepoIssue?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            if isLoading {
                ProgressView("Loading issue...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let issue = issue {
                VStack(alignment: .leading, spacing: 16) {
                    Text("#\(issue.number): \(issue.title)")
                        .font(.system(size: 16, weight: .semibold))

                    HStack(spacing: 8) {
                        Text(issue.state.capitalized)
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(issue.stateColor)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                        if !issue.labels.isEmpty {
                            ForEach(issue.labels.prefix(3), id: \.self) { label in
                                Text(label)
                                    .font(.system(size: 10, weight: .medium))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                            }
                        }
                    }

                    if let body = issue.body, !body.isEmpty {
                        Divider()
                        Text(body)
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }

                    Divider()
                    VStack(alignment: .leading, spacing: 6) {
                        if !issue.webUrl.isEmpty {
                            HStack(spacing: 6) {
                                Image(systemName: "link")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                Text(issue.webUrl)
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.current.info)
                            }
                        }
                        HStack(spacing: 6) {
                            Image(systemName: "clock")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                            Text(AppDateFormatter.relativeISO(issue.updatedAt))
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                        if issue.commentCount > 0 {
                            HStack(spacing: 6) {
                                Image(systemName: "bubble.left")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                Text("\(issue.commentCount) comment\(issue.commentCount == 1 ? "" : "s")")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    Spacer()
                    Button("Done") {
                        dismiss()
                        onConfirm()
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(maxWidth: .infinity)
                }
                .padding(20)
            } else if let error = error {
                VStack(spacing: 12) {
                    Text("Failed to load issue")
                        .font(.system(size: 14, weight: .semibold))
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    Button("Close") {
                        dismiss()
                        onConfirm()
                    }
                    .buttonStyle(.bordered)
                }
                .padding(20)
            }
        }
        .frame(width: 500, height: 400)
        .task {
            await loadIssue()
        }
    }

    private func loadIssue() async {
        isLoading = true
        defer { isLoading = false }

        let client = RepoBackendFactory.backend(for: providerKind, config: AppConfig.shared)

        do {
            let filter = RepoIssueFilter(state: .all, search: "", labelName: "")
            let issues = try await client.listIssues(projectId: projectId, filter: filter, page: 1)
            if let found = issues.first(where: { $0.number == iid }) {
                issue = found
            } else {
                error = "Issue #\(iid) not found"
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

}
