import SwiftUI

/// "Add Task" sheet for the Auto Tasks page — name + prompt template.
/// Styled like FileNamePromptSheet (Explorer's create/rename sheet): the
/// parent owns error display via the `onConfirm` closure's throw-free
/// contract here (validation is inline, Save is disabled until valid).
struct AddCustomAutoTaskSheet: View {
    let onConfirm: (String, String) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @State private var template: String = ""

    private var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("New Custom Task").font(Typography.title)

            Text("Name").font(Typography.caption).foregroundStyle(.secondary)
            TextField("e.g. \"Nightly Cleanup\"", text: $name)
                .textFieldStyle(.roundedBorder)

            Text("Prompt").font(Typography.caption).foregroundStyle(.secondary)
            TextEditor(text: $template)
                .font(Typography.mono)
                .frame(minHeight: 160)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1))
                .cornerRadius(6)

            HStack {
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Create") { onConfirm(name, template) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
            }
        }
        .padding(Spacing.md)
        .frame(width: 420)
    }
}
