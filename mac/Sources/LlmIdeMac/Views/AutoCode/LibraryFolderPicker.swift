import SwiftUI

/// Picks a project folder for an Auto Task's input or output.
///
/// Same principle as `LibraryPicker`: the Library is where a project's content
/// lives, so a task points somewhere inside it rather than opening a browser
/// onto the whole disk. Unlike `LibraryPicker` this selects a FOLDER — a task
/// reads or writes a directory — and the rows come from
/// `AutoTaskFolderCatalog`, the same scan the iPhone's picker is served from.
struct LibraryFolderPicker: View {
    /// Sheet title, e.g. "Input folder".
    let title: String
    /// The project the paths are relative to.
    let projectRoot: URL?
    /// Currently selected project-relative path (nil = whole project).
    let selection: String?
    let onSelect: (String?) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var folders: [AutoTaskFolderCatalog.Folder] = []
    /// The scan runs off the main actor, so `folders` is empty before it lands.
    /// Without this the sheet opened claiming the project has no folders —
    /// a false negative, and the more visible the bigger the project.
    @State private var isScanning = true

    private var filtered: [AutoTaskFolderCatalog.Folder] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return folders }
        return folders.filter { $0.path.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
            }
            .padding()
            Divider()

            if projectRoot == nil {
                message("Open a project to choose a folder.")
            } else {
                TextField("Filter folders", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)

                List {
                    Section {
                        row(path: nil, label: "Whole project",
                            detail: projectRoot?.lastPathComponent ?? "",
                            icon: "folder", indent: 0)
                    }
                    ForEach(LibraryItem.Category.allCases) { category in
                        let rows = filtered.filter { $0.category == category }
                        if !rows.isEmpty {
                            Section(category.sectionTitle) {
                                ForEach(rows) { folder in
                                    row(path: folder.path,
                                        label: folder.path.components(separatedBy: "/").last ?? folder.path,
                                        detail: folder.path, icon: category.icon,
                                        indent: folder.depth - 1)
                                }
                            }
                        }
                    }
                }
                .listStyle(.inset)

                if isScanning {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading the project's folders…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding()
                } else if filtered.isEmpty {
                    message(folders.isEmpty
                            ? "This project has no Library folders yet."
                            : "No folder matches “\(query)”.")
                }
            }

            Divider()
            HStack {
                Button("Clear") {
                    onSelect(nil)
                    dismiss()
                }
                .disabled(selection == nil)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding()
        }
        .frame(minWidth: 460, minHeight: 420)
        // Off the main actor: the scan walks up to four levels of the project's
        // Library folders, which is not something to do while the sheet is
        // trying to appear.
        .task {
            let root = projectRoot
            isScanning = true
            folders = await Task.detached(priority: .userInitiated) {
                AutoTaskFolderCatalog.scan(projectRoot: root)
            }.value
            isScanning = false
        }
    }

    private func row(path: String?, label: String, detail: String,
                     icon: String, indent: Int) -> some View {
        let isSelected = path == selection
        return Button {
            onSelect(path)
            dismiss()
        } label: {
            HStack(spacing: 9) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                Image(systemName: icon)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                Text(label).lineLimit(1)
                Spacer(minLength: 8)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            .padding(.leading, CGFloat(indent) * 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
    }
}
