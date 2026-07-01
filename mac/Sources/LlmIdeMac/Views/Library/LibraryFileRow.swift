import SwiftUI

struct LibraryFileRow: View {
    let item: LibraryItem
    @Environment(LibraryItemStore.self) private var store
    @State private var showRemoveConfirmation = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: item.fileIcon)
                .font(Typography.filename)
                .foregroundStyle(item.fileIconColor)
                .frame(width: 18, alignment: .center)

            VStack(alignment: .leading, spacing: 1) {
                Text(item.name)
                    .font(Typography.filename)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Text(item.ext.isEmpty ? "file" : item.ext.uppercased())
                        .font(Typography.fileMeta)
                        .foregroundStyle(.secondary)
                    if let size = fileSize {
                        Text("·").font(Typography.fileMeta).foregroundStyle(.tertiary)
                        Text(size).font(Typography.fileMeta).foregroundStyle(.secondary)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([item.url])
            }
            Divider()
            Button("Remove from Library", role: .destructive) {
                showRemoveConfirmation = true
            }
        }
        .confirmationDialog("Remove \"\(item.name)\" from the library?", isPresented: $showRemoveConfirmation) {
            Button("Remove", role: .destructive) {
                store.remove(id: item.id)
            }
        } message: {
            Text("The file will remain on disk but won't appear in the library.")
        }
    }

    // Size is captured during the (off-main) library scan and read straight off
    // the model — no synchronous `stat()` per row in `body`, which previously
    // ran hundreds of blocking filesystem calls per layout pass on big folders.
    private var fileSize: String? {
        guard let bytes = item.sizeBytes else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
