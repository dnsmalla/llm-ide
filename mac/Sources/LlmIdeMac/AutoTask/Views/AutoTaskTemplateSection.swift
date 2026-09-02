import SwiftUI

/// The "Template" card in an Auto Task's detail pane: which saved prompt says
/// what the task should do, plus editing, renaming, and duplicating it.
///
/// Two sources of prompt text exist and the picker chooses between them:
///
/// - **the task's own prompt** — the built-in `AppConfig` template for a
///   built-in task, or the inline text of a custom task. This is what every
///   task used before templates existed, so it stays the default and nothing
///   changes for a user who never opens the picker.
/// - **a saved template** — a file in `templates/auto_task/`, shared by every
///   task that selects it and editable here.
///
/// Edits to a saved template are explicit (a Save button on a dirty draft), not
/// keystroke-by-keystroke: the file is shared, so a half-typed prompt must not
/// become what the other tasks using it run tonight.
struct AutoTaskTemplateSection: View {
    let taskId: String
    /// The task's own prompt, when it has an editable one. nil for a
    /// structural task — then only saved templates are offered.
    let ownPrompt: Binding<String>?
    /// Label for the "own prompt" row, e.g. "Built-in prompt".
    let ownPromptLabel: String
    /// Called when the user asks to restore the built-in default. nil hides it.
    var onRestoreDefault: (() -> Void)?

    @ObservedObject var configs: AutoTaskConfigStore
    @ObservedObject var templates: AutoTaskTemplateStore

    @EnvironmentObject private var theme: ThemeStore

    @State private var showingNewSheet = false
    @State private var showingRenameSheet = false
    @State private var pendingDelete: AutoTaskTemplate?
    @State private var errorMessage: String?

    private var config: AutoTaskConfig { configs.config(for: taskId) }
    private var selected: AutoTaskTemplate? { templates.template(id: config.templateId) }

    /// The editor's text lives in the store, not in `@State`: the detail pane
    /// reuses one view tree across tasks, so view state was silently discarded
    /// on every sidebar click. See `AutoTaskTemplateStore.drafts`.
    private func draftBinding(_ template: AutoTaskTemplate) -> Binding<String> {
        Binding(
            get: { templates.editorText(for: template.id) ?? template.body },
            set: { templates.setDraft($0, for: template.id) }
        )
    }

    var body: some View {
        AutoTaskSectionCard("Template", systemImage: "doc.text",
                            accessory: AnyView(headerButtons)) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                picker

                if let message = errorMessage {
                    Text(message)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let template = selected {
                    savedTemplateEditor(template)
                } else if let ownPrompt {
                    editor(text: ownPrompt)
                    Text("This prompt belongs to this task alone. Save it as a template to reuse it in others.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("This task has no prompt of its own — pick a saved template to give it one.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                placeholderHint
            }
        }
        .sheet(isPresented: $showingNewSheet) {
            AutoTaskTemplateNameSheet(
                title: "New Template",
                initialName: "",
                confirmLabel: "Create"
            ) { name in
                guard let created = templates.create(name: name, body: currentBodyForNewTemplate()) else {
                    errorMessage = "Could not write the template. Check that the project folder is writable."
                    return
                }
                errorMessage = nil
                var next = config
                next.templateId = created.id
                configs.update(next, for: taskId)
            }
        }
        .sheet(isPresented: $showingRenameSheet) {
            AutoTaskTemplateNameSheet(
                title: "Rename Template",
                initialName: selected?.name ?? "",
                confirmLabel: "Rename"
            ) { name in
                guard let template = selected else { return }
                guard let newId = templates.rename(id: template.id, to: name) else {
                    errorMessage = "Could not rename the template."
                    return
                }
                errorMessage = nil
                // The store repoints every referring config through
                // `onTemplateIdChanged`; re-read rather than assuming, so a
                // wiring change can't leave this task pointing at a dead id.
                if configs.config(for: taskId).templateId != newId {
                    var next = configs.config(for: taskId)
                    next.templateId = newId
                    configs.update(next, for: taskId)
                }
            }
        }
        .confirmationDialog(
            pendingDelete.map { "Delete “\($0.name)”?" } ?? "",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let template = pendingDelete { _ = templates.delete(id: template.id) }
                pendingDelete = nil
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("The file is removed from templates/auto_task/. Every task using it falls back to its own prompt.")
        }
    }

    // MARK: - Picker + header

    private var picker: some View {
        Picker("Template", selection: Binding(
            get: { config.templateId ?? "" },
            set: { id in
                var next = config
                next.templateId = id.isEmpty ? nil : id
                configs.update(next, for: taskId)
            }
        )) {
            Text(ownPrompt == nil ? "None" : ownPromptLabel).tag("")
            // A template referenced by this task but missing from disk (deleted
            // outside the app) keeps a row, so the picker shows what the task
            // is actually set to instead of silently reading as "own prompt".
            if let id = config.templateId, templates.template(id: id) == nil {
                Text("\(id) (missing)").tag(id)
            }
            ForEach(templates.templates) { template in
                Text(template.name).tag(template.id)
            }
        }
        .labelsHidden()
        .disabled(!templates.hasProject)
    }

    private var headerButtons: some View {
        HStack(spacing: 10) {
            if let onRestoreDefault, selected == nil, ownPrompt != nil {
                Button("Restore Default", action: onRestoreDefault)
                    .buttonStyle(.borderless)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Button("New…") { showingNewSheet = true }
                .buttonStyle(.borderless)
                .font(Typography.caption)
                .disabled(!templates.hasProject)
                .help(templates.hasProject
                      ? "Save the current prompt as a reusable template"
                      : "Open a project to save templates")
            if selected != nil {
                Button("Rename…") { showingRenameSheet = true }
                    .buttonStyle(.borderless)
                    .font(Typography.caption)
                Button("Duplicate") {
                    guard let template = selected,
                          let copy = templates.duplicate(id: template.id) else { return }
                    var next = config
                    next.templateId = copy.id
                    configs.update(next, for: taskId)
                }
                .buttonStyle(.borderless)
                .font(Typography.caption)
                Button("Delete") { pendingDelete = selected }
                    .buttonStyle(.borderless)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
            }
        }
    }

    // MARK: - Editors

    @ViewBuilder
    private func savedTemplateEditor(_ template: AutoTaskTemplate) -> some View {
        let isDirty = templates.hasDraft(for: template.id)
        editor(text: draftBinding(template))
        HStack(spacing: 8) {
            Text(template.url?.lastPathComponent ?? "\(template.id).md")
                .font(Typography.mono)
                .foregroundStyle(theme.current.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if isDirty {
                Text("Unsaved")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.warning)
                Button("Revert") { templates.discardDraft(for: template.id) }
                    .controlSize(.small)
            }
            Button("Save") {
                let body = templates.editorText(for: template.id) ?? template.body
                guard templates.update(id: template.id, body: body) else {
                    errorMessage = "Could not save the template."
                    return
                }
                errorMessage = nil
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(!isDirty)
        }
    }

    private func editor(text: Binding<String>) -> some View {
        TextEditor(text: text)
            .font(Typography.mono)
            .foregroundStyle(theme.current.text)
            .scrollContentBackground(.hidden)
            .background(theme.current.body)
            .frame(minHeight: 160)
            .overlay(RoundedRectangle(cornerRadius: Radius.sm)
                .strokeBorder(theme.current.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }

    private var placeholderHint: some View {
        Text("Placeholders: \(AutoTaskTemplate.placeholders.joined(separator: "  ")) — replaced with the paths above when the task runs.")
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Seed text for a brand-new template: whatever prompt is on screen now, so
    /// "New…" captures the prompt the user was just looking at.
    private func currentBodyForNewTemplate() -> String {
        if let template = selected {
            return templates.editorText(for: template.id) ?? template.body
        }
        return ownPrompt?.wrappedValue ?? ""
    }
}

/// Name prompt shared by New and Rename. Styled like `AddCustomAutoTaskSheet`.
private struct AutoTaskTemplateNameSheet: View {
    let title: String
    let initialName: String
    let confirmLabel: String
    let onConfirm: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""

    private var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(title).font(Typography.title)
            Text("Name").font(Typography.caption).foregroundStyle(.secondary)
            TextField("e.g. “Nightly API Review”", text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit { if isValid { confirm() } }
            Text("Saved to templates/auto_task/ as a markdown file.")
                .font(Typography.caption)
                .foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(confirmLabel) { confirm() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
            }
        }
        .padding(Spacing.md)
        .frame(width: 380)
        .onAppear { name = initialName }
    }

    private func confirm() {
        onConfirm(name.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
    }
}
