import SwiftUI
import SharedProtocol

/// Create, edit, rename, or delete one Auto Task prompt template on the paired
/// Mac.
///
/// `template == nil` means create. The name field is separate from the body
/// because renaming and re-saving are different operations on the Mac: the
/// template's id is its filename stem, so a rename moves the file and repoints
/// every task that referenced it, while a body save rewrites in place.
struct AutoTaskTemplateEditorView: View {
    /// The template being edited, or nil to create a new one.
    let template: AutoTaskTemplateInfo?

    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var body_: String = ""
    @State private var showingDeleteConfirm = false

    private var isNew: Bool { template == nil }
    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var isValid: Bool {
        !trimmedName.isEmpty && !body_.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var nameChanged: Bool {
        guard let template else { return false }
        return trimmedName != template.name
    }
    private var bodyChanged: Bool {
        guard let template else { return !body_.isEmpty }
        return body_ != template.body
    }

    var body: some View {
        Form {
            Section("Name") {
                TextField("e.g. Nightly API Review", text: $name)
                    .autocorrectionDisabled()
            }

            Section {
                TextEditor(text: $body_)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(minHeight: 240)
            } header: {
                Text("Prompt")
            } footer: {
                Text("Placeholders {{INPUT_PATH}}, {{OUTPUT_PATH}} and {{PROJECT_ROOT}} are replaced with the task's configured paths when it runs.")
            }

            if !isNew {
                Section {
                    Button(role: .destructive) {
                        showingDeleteConfirm = true
                    } label: {
                        Label("Delete Template", systemImage: "trash")
                    }
                } footer: {
                    Text("Removes the file from templates/auto_task/. Every task using it falls back to its own prompt.")
                }
            }
        }
        .navigationTitle(isNew ? "New Template" : "Edit Template")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save") { save() }
                    .disabled(!isValid || (!isNew && !nameChanged && !bodyChanged))
            }
        }
        .confirmationDialog("Delete “\(template?.name ?? "")”?",
                            isPresented: $showingDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let template { autoTaskStore.deleteTemplate(id: template.id) }
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            name = template?.name ?? ""
            body_ = template?.body ?? ""
        }
    }

    /// One frame carries both the name and the body.
    ///
    /// Sending a save and a rename as two frames looked simpler but was a race:
    /// the Mac dispatches each inbound message as its own unstructured task, so
    /// there is no ordering guarantee, and a rename serviced first moves the
    /// file — the body write then targets an id that no longer exists and is
    /// silently lost while the rename appears to succeed. The Mac applies both
    /// in one handler instead.
    private func save() {
        autoTaskStore.saveTemplate(id: template?.id, name: trimmedName, body: body_)
        dismiss()
    }
}
