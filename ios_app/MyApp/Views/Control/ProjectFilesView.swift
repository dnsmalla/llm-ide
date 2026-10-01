import SwiftUI
import SharedProtocol

/// Read-only file browser for the Mac project. Dotfiles, secrets and build folders are hidden by the
/// Mac; there is nothing here that can change a file.
struct ProjectFilesView: View {
    var path: String = ""
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: FilesStore

    private var listing: FilesListing? { store.listings[path] }

    var body: some View {
        List {
            if let listing {
                if let error = listing.error {
                    Section { Text(error).font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else if listing.entries.isEmpty {
                    Section { Text("This folder is empty.").font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else {
                    Section {
                        ForEach(listing.entries) { entry in
                            let child = path.isEmpty ? entry.name : path + "/" + entry.name
                            NavigationLink {
                                if entry.isDirectory { ProjectFilesView(path: child) } else { FileContentView(path: child) }
                            } label: {
                                Label {
                                    Text(entry.name).lineLimit(1)
                                } icon: {
                                    Image(systemName: entry.isDirectory ? "folder.fill" : Self.icon(for: entry.name))
                                        .foregroundColor(DesignSystem.Colors.primary)
                                }
                            }
                        }
                    } footer: {
                        if listing.truncated { Text("Showing the first part of a long folder.") }
                    }
                }
            } else {
                Section {
                    HStack(spacing: DesignSystem.Spacing.sm) {
                        ProgressView()
                        Text(connection.connectionStatus == .connected ? "Loading…" : "Connect to your Mac.")
                            .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, DesignSystem.Spacing.md)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle(path.isEmpty ? "Files" : (path.split(separator: "/").last.map(String.init) ?? path))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.invalidate(path); store.list(path) } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .refreshable { store.invalidate(path); store.list(path) }
        .task { if listing == nil || listing?.error != nil { store.list(path) } }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, listing == nil || listing?.error != nil { store.list(path) }
        }
    }

    static func icon(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "swift", "js", "ts", "tsx", "py", "mjs", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "m": return "chevron.left.forwardslash.chevron.right"
        case "md", "txt", "markdown": return "doc.text"
        case "json", "yml", "yaml", "toml", "plist": return "curlybraces"
        default: return "doc"
        }
    }
}

struct FileContentView: View {
    let path: String
    @EnvironmentObject var store: FilesStore

    private var file: FilesFile? { store.files[path] }

    var body: some View {
        ScrollView {
            if let file {
                if let error = file.error {
                    Text(error).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary)
                        .padding(DesignSystem.Spacing.md)
                } else if let text = file.text {
                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
                        if file.truncated {
                            Label("Long file — showing the first part.", systemImage: "scissors")
                                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        if (path as NSString).pathExtension.lowercased() == "md" {
                            MarkdownDocumentView(text: text).frame(maxWidth: 640, alignment: .leading)
                        } else {
                            codeBody(text)
                        }
                    }
                    .padding(DesignSystem.Spacing.sm)
                }
            } else {
                ProgressView().padding(.top, 60).frame(maxWidth: .infinity)
            }
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let text = file?.text {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: text) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share file text")
                }
            }
        }
        .task { if file == nil || file?.error != nil { store.read(path) } }
        .refreshable { store.invalidate(path); store.read(path) }
    }

    private func codeBody(_ text: String) -> some View {
        ChunkedLinesView(text: text, chunk: 500) { index, line in
            HStack(alignment: .top, spacing: 8) {
                Text("\(index + 1)").foregroundColor(DesignSystem.Colors.textTertiary).frame(minWidth: 34, alignment: .trailing)
                Text(line.isEmpty ? " " : line).foregroundColor(DesignSystem.Colors.textPrimary).textSelection(.enabled)
            }
            .font(DesignSystem.Typography.codeFont)
        }
    }
}
