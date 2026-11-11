import SwiftUI
import SharedProtocol

/// Read-only project explorer. Folders are navigated one level at a time; text files open in a bounded reader.
struct ExplorerView: View {
    @EnvironmentObject var files: FilesStore
    @EnvironmentObject var projects: ProjectsStore
    @State private var path = ""
    @State private var open: HostApiFilesListResultEntriesItem?

    private var projectId: String? { projects.selectedId }

    var body: some View {
        List {
            if let error = files.error {
                Section { Text(error).foregroundColor(DesignSystem.Colors.danger) }
            }
            if files.loading && files.entries.isEmpty { ProgressView("Loading…") }
            Section(path.isEmpty ? "Project files" : path) {
                if !path.isEmpty {
                    Button { up() } label: { Label("Up", systemImage: "chevron.up") }
                }
                ForEach(files.entries, id: \.path) { entry in
                    if entry.kind == "dir" {
                        Button { openDir(entry) } label: {
                            HStack { Image(systemName: "folder"); Text(entry.name); Spacer(); Image(systemName: "chevron.right").foregroundColor(.secondary) }
                        }
                    } else {
                        Button { openFile(entry) } label: {
                            HStack {
                                Image(systemName: "doc.text")
                                Text(entry.name).lineLimit(1)
                                Spacer()
                                if let size = entry.size { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundColor(.secondary) }
                            }
                        }
                    }
                }
                if files.entries.isEmpty && !files.loading && files.error == nil {
                    Text("This folder is empty.").foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
        }
        .navigationTitle("Explorer")
        .sheet(item: $open) { entry in
            FileTextView(name: entry.name, path: entry.path, projectId: projectId)
        }
        .task { if let projectId, files.entries.isEmpty { await files.list(projectId: projectId) } }
        .refreshable { if let projectId { await files.list(projectId: projectId, path: path) } }
    }

    private func openDir(_ entry: HostApiFilesListResultEntriesItem) {
        guard let projectId else { return }
        path = entry.path
        Task { await files.list(projectId: projectId, path: entry.path) }
    }

    private func up() {
        guard let projectId else { return }
        let parent = path.split(separator: "/").dropLast().joined(separator: "/")
        path = parent
        Task { await files.list(projectId: projectId, path: parent) }
    }

    private func openFile(_ entry: HostApiFilesListResultEntriesItem) {
        guard let projectId else { return }
        open = entry
        Task { await files.read(projectId: projectId, path: entry.path) }
    }
}

extension HostApiFilesListResultEntriesItem: @retroactive Identifiable {
    public var id: String { path }
}

private struct FileTextView: View {
    let name: String
    let path: String
    let projectId: String?
    @EnvironmentObject var files: FilesStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                if files.loading { ProgressView("Loading…").padding() }
                else if let f = files.file {
                    Text(f.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding()
                    if f.truncated { Text("Showing the first \(f.size) bytes.").font(.caption).foregroundColor(.secondary).padding(.horizontal) }
                } else if let e = files.error { Text(e).foregroundColor(DesignSystem.Colors.danger).padding() }
            }
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { UIPasteboard.general.string = files.file?.text } label: { Image(systemName: "doc.on.doc") }
                        .accessibilityLabel("Copy file text")
                        .disabled(files.file == nil)
                }
            }
            .task { if let projectId, files.file == nil { await files.read(projectId: projectId, path: path) } }
        }
    }
}
