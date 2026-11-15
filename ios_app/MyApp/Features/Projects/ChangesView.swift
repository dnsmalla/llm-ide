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
    @State private var message = ""
    @State private var busy = false
    @State private var result: String?
    @State private var confirmCommit = false
    @State private var confirmPush = false

    var body: some View {
        Group {
            if let id = projectsStore.selectedId {
                content(projectId: id)
            } else {
                EmptyChatState(icon: "folder", title: "No project selected",
                               subtitle: "Choose a project in the picker first.")
            }
        }
        .navigationTitle("Changes")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") } .disabled(loading) }
        }
        .alert("Commit these files?", isPresented: $confirmCommit) {
            Button("Cancel", role: .cancel) {}
            Button("Commit") { Task { await commit() } }
        } message: { Text("Only the changed files listed here are committed.") }
        .alert("Push this branch?", isPresented: $confirmPush) {
            Button("Cancel", role: .cancel) {}
            Button("Push") { Task { await push() } }
        } message: { Text("Pushes the current branch to its upstream.") }
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
            if let result { Section { Text(result).foregroundStyle(.secondary) } }
            if let e = error { Section { Text(e).foregroundStyle(.red) } }
            if let s = status, !s.clean {
                Section("Commit") {
                    TextField("Commit message", text: $message)
                    Button("Commit all changed files") { confirmCommit = true }
                        .disabled(busy || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Push branch") { confirmPush = true }.disabled(busy)
                }
            }
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

    private func commit() async {
        guard let id = projectsStore.selectedId, let s = status else { return }
        busy = true; error = nil; result = nil
        do {
            let req = HostApiGitCommitRequest(message: message, paths: s.entries.map(\.path), projectId: id)
            let data = try await connection.host.send(.gitCommit, payload: JSONEncoder().encode(req), id: nil)
            let r = try JSONDecoder().decode(HostApiGitCommitResult.self, from: data)
            result = "Committed \(r.commit.prefix(10)): \(r.summary)"
            message = ""
            await load()
        } catch { self.error = error.localizedDescription }
        busy = false
    }

    private func push() async {
        guard let id = projectsStore.selectedId else { return }
        busy = true; error = nil; result = nil
        do {
            let data = try await connection.host.send(.gitPush, payload: JSONEncoder().encode(HostApiGitPushRequest(projectId: id)), id: nil)
            let r = try JSONDecoder().decode(HostApiGitPushResult.self, from: data)
            result = r.ok ? r.output : "Push failed: \(r.output)"
        } catch { self.error = error.localizedDescription }
        busy = false
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
