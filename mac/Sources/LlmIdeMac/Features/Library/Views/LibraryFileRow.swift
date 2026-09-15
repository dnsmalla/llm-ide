import SwiftUI

/// A file leaf in the Library sidebar, rendered with the SAME `TreeRowLabel`
/// the Explorer tree uses — one compact line with indent guides, the
/// extension's icon and color, and the name.
///
/// It used to be a two-line row of its own (name over "EXT · size") with no
/// depth at all, which is what made the Library's tree read as a different
/// control from the Explorer's. The size now lives in the detail pane only.
struct LibraryFileRow: View {
    let item: LibraryItem
    /// Nesting level inside the section, for the indent guides. Folder groups
    /// and tree sections pass the row's real depth; flat lists leave it at 0.
    var depth: Int = 0
    @Environment(LibraryItemStore.self) private var store
    @State private var showRemoveConfirmation = false

    var body: some View {
        TreeRowLabel(name: item.name,
                     isFolder: false,
                     isExpanded: false,
                     depth: depth,
                     fileExtension: item.ext)
        .help(item.name)
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
            Button("Delete", role: .destructive) {
                store.remove(id: item.id)
            }
        } message: {
            // Must match store.remove(id:)'s actual behavior: a file INSIDE
            // the project is deleted from disk (items is a derived scan, so
            // an in-memory removal would just be resurrected by the next
            // rescan); external referenced files are never touched.
            Text("The file will be deleted from the project folder. Files in external referenced folders are never deleted.")
        }
    }
}
