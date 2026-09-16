import SwiftUI

/// Reusable name-entry sheet for Explorer create/rename. The parent owns the
/// `error` binding: on confirm it attempts the op, dismisses on success or
/// sets `error` to keep the sheet open with an inline message.
struct FileNamePromptSheet: View {
    enum Mode { case newFile, newFolder, rename }

    let mode: Mode
    let initialName: String
    @Binding var error: String?
    let onConfirm: (String) -> Void
    let onCancel: () -> Void

    @State private var name: String

    init(mode: Mode, initialName: String = "", error: Binding<String?>,
         onConfirm: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.mode = mode
        self.initialName = initialName
        self._error = error
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        _name = State(initialValue: initialName)
    }

    private var title: String {
        switch mode {
        case .newFile: return "New File"
        case .newFolder: return "New Folder"
        case .rename: return "Rename"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(title).font(Typography.title)
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit { onConfirm(name) }
            if let error {
                Text(error).font(Typography.caption).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button(mode == .rename ? "Rename" : "Create") { onConfirm(name) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(Spacing.md)
        .frame(width: 320)
    }
}
