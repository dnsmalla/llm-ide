import SwiftUI
import SharedProtocol

/// Read-only git review for the selected Host API project. Status and one unified diff travel over the same pinned
/// v1 connection as chat; source files never leave the host.
struct ChangesView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var projectsStore: ProjectsStore

    @State private var status: HostApiGitStatusResult?
    @State private var selected: String?
    @State private var patch = ""
    @State private var truncated = false
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        Group {
            if let id = projectsStore.selectedId {
                content(projectId: id)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "folder").font(.largeTitle).foregroundStyle(.secondary)
                    Text("No project selected").font(.headline)
                    Text("Choose a project in the picker first.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Changes")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") } .disabled(loading) } }
        .task(id: projectsStore.selectedId) { await load() }
    }

    @ViewBuilder private func content(projectId: String) -> some View {
        List {
            if let s = status {
                Section {
                    LabeledContent("Branch", value: s.branch)
                    if s.ahead != 0 || s.behind != 0 { LabeledContent("Ahead / behind", value: "\(s.ahead) / \(s.behind)") }
                }
                if s.clean {
                    Section { Text("Working tree clean.").foregroundStyle(.secondary) }
                } else {
                    Section("Changed files") {
                        ForEach(s.entries, id: \.path) { e in
                            Button {
                                selected = e.path
                                Task { await diff(projectId: projectId, path: e.path) }
                            } label: {
                                HStack {
                                    Text(e.status).font(.caption.monospaced()).foregroundStyle(.secondary)
                                    Text(e.path).lineLimit(1)
                                    Spacer()
                                    if selected == e.path { Image(systemName: "chevron.right.circle.fill") }
                                }
                            }
                        }
                    }
                }
            }
            if let e = error { Section { Text(e).foregroundStyle(.red) } }
            if !patch.isEmpty {
                Section(truncated ? "Diff (truncated)" : "Diff") {
                    ScrollView(.horizontal) { Text(patch).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }
            }
        }
        .overlay { if loading && status == nil { ProgressView() } }
    }

    private func load() async {
        guard let id = projectsStore.selectedId else { return }
        loading = true; error = nil
        do {
            let data = try await connection.host.send(.gitStatus, payload: JSONEncoder().encode(HostApiGitStatusRequest(projectId: id)), id: nil)
            status = try JSONDecoder().decode(HostApiGitStatusResult.self, from: data)
            selected = nil; patch = ""; truncated = false
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func diff(projectId: String, path: String) async {
        loading = true; error = nil
        do {
            let data = try await connection.host.send(.gitDiff, payload: JSONEncoder().encode(HostApiGitDiffRequest(path: path, projectId: projectId, staged: false)), id: nil)
            let r = try JSONDecoder().decode(HostApiGitDiffResult.self, from: data)
            patch = r.patch; truncated = r.truncated
        } catch { self.error = error.localizedDescription }
        loading = false
    }
}
