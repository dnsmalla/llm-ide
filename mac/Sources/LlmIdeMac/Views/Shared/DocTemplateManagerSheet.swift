import SwiftUI

struct DocTemplateManagerSheet: View {
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var store: DocTemplateStore
    @EnvironmentObject private var projectStore: ProjectStore
    @Environment(\.dismiss) private var dismiss

    @State private var selectedID: UUID?
    @State private var editingTemplate: DocTemplate?
    @State private var newSectionName = ""
    @State private var showDeleteConfirmation = false

    private var selectedTemplate: DocTemplate? {
        guard let id = selectedID else { return nil }
        return store.templates.first { $0.id == id }
    }

    var body: some View {
        HSplitView {
            templateList
                .frame(minWidth: 180, idealWidth: 200, maxWidth: 240)
            detailPanel
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 560, minHeight: 480)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
            }
        }
        .onAppear {
            if selectedID == nil {
                selectedID = store.templates.first?.id
            }
        }
    }

    private var templateList: some View {
        VStack(spacing: 0) {
            if store.hasProjectTemplates {
                Text("Templates live in your project's `templates/` folder.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
            }

            List(selection: $selectedID) {
                if store.templates.isEmpty {
                    Text("No templates yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.vertical, 8)
                } else {
                    ForEach(store.templates) { t in
                        Text(t.name).tag(t.id)
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()

            Button {
                let newTemplate = DocTemplate(
                    id: UUID(),
                    name: "New Template",
                    sections: ["Section 1"],
                    rawContent: nil,
                    isBuiltin: false)
                let created = store.add(newTemplate)
                selectedID = created.id
                editingTemplate = created
            } label: {
                Label("New", systemImage: "plus")
                    .font(.callout)
            }
            .buttonStyle(.borderless)
            .padding(10)
        }
    }

    @ViewBuilder
    private var detailPanel: some View {
        if let template = selectedTemplate {
            customDetail(template)
        } else {
            Text("Select a template")
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func customDetail(_ template: DocTemplate) -> some View {
        let binding = Binding<DocTemplate>(
            get: { editingTemplate ?? template },
            set: { editingTemplate = $0 }
        )
        let editable = template.isEditable

        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 16) {
                if template.isBuiltin && !store.hasProjectTemplates {
                    Text("Built-in template — duplicate to customize, or open a project to edit `templates/` on disk.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let folder = template.folderName {
                    Text("Saved as `templates/\(folder)/template.md`")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                TextField("Template name", text: Binding(
                    get: { binding.wrappedValue.name },
                    set: { binding.wrappedValue.name = $0 }
                ))
                .textFieldStyle(.roundedBorder)
                .font(.title3)
                .disabled(!editable)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Sections")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    List {
                        ForEach(binding.wrappedValue.sections, id: \.self) { section in
                            HStack {
                                Text(section)
                                    .font(.callout)
                                Spacer()
                                Button {
                                    binding.wrappedValue.sections.removeAll { $0 == section }
                                } label: {
                                    Image(systemName: "minus.circle")
                                        .foregroundStyle(theme.current.danger.opacity(0.8))
                                }
                                .buttonStyle(.borderless)
                                .disabled(!editable)
                            }
                        }
                        .onMove { from, to in
                            binding.wrappedValue.sections.move(fromOffsets: from, toOffset: to)
                        }
                    }
                    .listStyle(.bordered)
                    .frame(minHeight: 160)
                    .disabled(!editable)

                    HStack {
                        TextField("Add section…", text: $newSectionName)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { addSection(to: binding) }
                            .disabled(!editable)
                        Button("Add") { addSection(to: binding) }
                            .buttonStyle(.bordered)
                            .disabled(!editable || newSectionName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .padding(20)

            Spacer()

            Divider()

            HStack {
                if editable {
                    Button("Delete", role: .destructive) {
                        showDeleteConfirmation = true
                    }
                    .buttonStyle(.bordered)
                    .confirmationDialog("Delete this template?", isPresented: $showDeleteConfirmation) {
                        Button("Delete", role: .destructive) {
                            store.delete(id: template.id)
                            selectedID = store.templates.first?.id
                            editingTemplate = nil
                        }
                    } message: {
                        Text(store.hasProjectTemplates
                             ? "The template folder will be removed from your project."
                             : "This template will be permanently deleted.")
                    }
                }

                Spacer()

                Button("Save") {
                    if var t = editingTemplate {
                        t.sections = t.sections.filter { !$0.isEmpty }
                        t.rawContent = nil
                        store.update(t)
                        editingTemplate = nil
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!editable || editingTemplate == nil)
            }
            .padding(16)
        }
        .onChange(of: selectedID) { _, _ in editingTemplate = nil }
    }

    private func addSection(to binding: Binding<DocTemplate>) {
        let name = newSectionName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        binding.wrappedValue.sections.append(name)
        newSectionName = ""
    }
}
