import SwiftUI

/// A sheet that lets a consumer panel select existing Library items, filtered
/// to the categories relevant to it. The Library (`LibraryItemStore`) is the
/// single place content enters a project; consumers reference what's already
/// there instead of opening their own file pickers. There is intentionally no
/// "browse to add" — if an item isn't in the Library, the user adds it from the
/// Library first.
struct LibraryPicker: View {
    enum Mode { case single, multi }

    let allowed: [LibraryItem.Category]
    let mode: Mode
    let title: String
    let onConfirm: ([LibraryItem]) -> Void

    @Environment(LibraryItemStore.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var selectedIds: Set<String> = []

    /// Pure, testable core: keep only items whose category is allowed,
    /// preserving the store's order.
    static func filter(_ items: [LibraryItem], allowed: Set<LibraryItem.Category>) -> [LibraryItem] {
        items.filter { allowed.contains($0.category) }
    }

    private var visible: [LibraryItem] {
        Self.filter(library.items, allowed: Set(allowed))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.headline)
                Spacer()
            }
            .padding()
            Divider()

            if visible.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(allowed) { category in
                        let rows = visible.filter { $0.category == category }
                        if !rows.isEmpty {
                            Section(category.sectionTitle) {
                                ForEach(rows) { row($0) }
                            }
                        }
                    }
                }
            }

            Divider()
            footer
        }
        .frame(minWidth: 420, minHeight: 380)
    }

    private func row(_ item: LibraryItem) -> some View {
        let isSel = selectedIds.contains(item.id)
        return Button {
            toggle(item)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: isSel ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSel ? Color.accentColor : Color.secondary)
                Image(systemName: item.category.icon)
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name).lineLimit(1)
                    if let folder = item.folderOrigin {
                        Text(folder).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func toggle(_ item: LibraryItem) {
        switch mode {
        case .single:
            selectedIds = [item.id]
        case .multi:
            if selectedIds.contains(item.id) { selectedIds.remove(item.id) }
            else { selectedIds.insert(item.id) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            Text("Nothing in the Library to pick").font(.headline)
            Text("Add \(allowed.map(\.sectionTitle).joined(separator: " / ")) from the Library first.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel") { dismiss() }
            Button("Add") {
                onConfirm(visible.filter { selectedIds.contains($0.id) })
                dismiss()
            }
            .disabled(selectedIds.isEmpty)
            .keyboardShortcut(.defaultAction)
        }
        .padding()
    }
}
