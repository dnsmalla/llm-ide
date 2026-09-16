import SwiftUI
import AppKit

/// Arguments for listing issues
struct ListIssuesSheetArgs {
    var search: String?
    var state: String?
    var label: String?
}

/// Sheet for listing/searching issues
struct ListIssuesSheet: View {
    let initialArgs: ListIssuesSheetArgs
    let projectId: String
    let providerKind: RepoBackendKind
    let onConfirm: () -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore
    @State private var searchQuery = ""
    @State private var stateFilter: String?
    @State private var labelFilter = ""
    @State private var issues: [RepoIssue] = []
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: 12) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                        TextField("Search issues", text: $searchQuery)
                            .textFieldStyle(.plain)
                            .onChange(of: searchQuery) { _, _ in Task { await loadIssues() } }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.secondary.opacity(0.05))
                    .cornerRadius(8)

                    Picker("State", selection: Binding(
                        get: { stateFilter ?? "" },
                        set: { stateFilter = $0.isEmpty ? nil : $0 }
                    )) {
                        Text("All States").tag("")
                        Text("Opened").tag("opened")
                        Text("Closed").tag("closed")
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: stateFilter) { _, _ in Task { await loadIssues() } }

                    HStack(spacing: 8) {
                        Image(systemName: "tag")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                        TextField("Filter by label", text: $labelFilter)
                            .textFieldStyle(.plain)
                            .onChange(of: labelFilter) { _, _ in Task { await loadIssues() } }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.secondary.opacity(0.05))
                    .cornerRadius(8)
                }
                .padding(16)

                Divider()
                if isLoading {
                    ProgressView("Searching issues...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = error {
                    VStack(spacing: 12) {
                        Text("Search failed")
                            .font(.system(size: 14, weight: .semibold))
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                        Button("Retry") { Task { await loadIssues() } }
                            .buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if issues.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.system(size: 40))
                            .foregroundStyle(.secondary)
                        Text("No issues found")
                            .font(.system(size: 14))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(issues) { issue in
                                IssueRow(issue: issue)
                                    .onTapGesture {
                                        let pasteboard = NSPasteboard.general
                                        pasteboard.clearContents()
                                        pasteboard.setString("#\(issue.number)", forType: .string)
                                    }
                            }
                        }
                    }
                }

                Divider()
                Button("Close") {
                    dismiss()
                    onConfirm()
                }
                .buttonStyle(.bordered)
                .padding(16)
            }
            .navigationTitle("Issues")
        }
        .frame(width: 600, height: 500)
        .task {
            searchQuery = initialArgs.search ?? ""
            stateFilter = initialArgs.state
            labelFilter = initialArgs.label ?? ""
            await loadIssues()
        }
    }

    private func loadIssues() async {
        isLoading = true
        defer { isLoading = false }

        let client = RepoBackendFactory.backend(for: providerKind, config: AppConfig.shared)

        do {
            let filter = RepoIssueFilter(
                state: stateFilter == nil ? .all : (stateFilter == "opened" ? .opened : .closed),
                search: searchQuery,
                labelName: labelFilter.isEmpty ? "" : labelFilter
            )
            self.issues = try await client.listIssues(projectId: projectId, filter: filter, page: 1)
            self.error = nil
        } catch {
            self.error = error.localizedDescription
            self.issues = []
        }
    }

    struct IssueRow: View {
        let issue: RepoIssue
        @EnvironmentObject var theme: ThemeStore

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    Text("#\(issue.number)")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.current.info)

                    Text(issue.title)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(2)

                    Spacer()
                    Text(issue.state.capitalized)
                        .font(.system(size: 10, weight: .medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(issue.stateColor)
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }

                HStack(spacing: 12) {
                    if !issue.labels.isEmpty {
                        Text(issue.labels.prefix(3).joined(separator: ", "))
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()
                    Text(AppDateFormatter.relativeISO(issue.updatedAt))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)

                    if issue.commentCount > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "bubble.left")
                                .font(.system(size: 9))
                            Text("\(issue.commentCount)")
                                .font(.system(size: 10))
                        }
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color.secondary.opacity(0.03))
        }

    }


}
