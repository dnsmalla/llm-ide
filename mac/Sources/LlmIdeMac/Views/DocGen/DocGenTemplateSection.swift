import SwiftUI

/// Step 1 of Doc Gen: a template (document structure) and/or a command
/// (instructions). Either alone is enough to generate; both may be selected
/// together (see `DocGenViewModel.canGenerate`).
struct DocGenTemplateSection: View {
    @ObservedObject var vm: DocGenViewModel
    @Binding var isExpanded: Bool

    @EnvironmentObject private var templateStore: DocTemplateStore
    @EnvironmentObject private var commandStore: DocCommandStore
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore

    @State private var showTemplateImporter = false
    @State private var showCommandImporter = false
    @State private var showTemplateManager = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                DocGenSectionHeader(
                    title: "Template & Command",
                    icon: "doc.badge.gearshape",
                    color: theme.current.accent,
                    isExpanded: $isExpanded)
                Spacer()
                Button { showTemplateManager = true } label: {
                    Text("Manage")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .padding(.trailing, 14)
                .padding(.top, 10)
            }

            if isExpanded {
                templatesGroup
                commandsGroup
            }
        }
        .sheet(isPresented: $showTemplateManager) {
            DocTemplateManagerSheet()
                .environmentObject(templateStore)
                .environmentObject(projectStore)
                .frame(minWidth: 580, minHeight: 500)
        }
        .fileImporter(
            isPresented: $showTemplateImporter,
            allowedContentTypes: [.plainText],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                if let template = templateStore.importMarkdownFile(at: url) {
                    vm.selectedTemplate = template
                }
            }
        }
        .fileImporter(
            isPresented: $showCommandImporter,
            allowedContentTypes: [.plainText],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                // Commands are project-only: with no project open,
                // `importMarkdownFile` returns nil and the picker silently
                // discards the file rather than pretending to select one.
                if let command = commandStore.importMarkdownFile(at: url) {
                    vm.selectedCommand = command
                }
            }
        }
    }

    // MARK: - Templates

    private var templatesGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                subheading("Templates")
                Spacer()
                Button { showTemplateImporter = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 20, height: 20)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 5))
                }
                .buttonStyle(.plain)
                .help("Import a .md template")
                .padding(.trailing, 14)
            }

            if templateStore.templates.isEmpty {
                // Import CTA when no templates yet
                Button { showTemplateImporter = true } label: {
                    HStack(spacing: 10) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(theme.current.accent.opacity(0.1))
                                .frame(width: 36, height: 36)
                            Image(systemName: "doc.badge.plus")
                                .font(.system(size: 15))
                                .foregroundStyle(theme.current.accent)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Import .md template")
                                .font(.callout.weight(.medium))
                                .foregroundStyle(.primary)
                            Text("Select a Markdown file to use as your document template")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            if projectStore.activeProject != nil {
                                Text("Imports into `templates/<name>/template.md` in your project.")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(theme.current.accent.opacity(0.04))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(
                                theme.current.accent.opacity(0.2),
                                style: StrokeStyle(lineWidth: 1, dash: [5])
                            )
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
            } else {
                // Template list
                VStack(spacing: 3) {
                    ForEach(templateStore.templates) { template in
                        templateRow(template)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
    }

    @ViewBuilder
    private func templateRow(_ template: DocTemplate) -> some View {
        let selected = vm.selectedTemplate?.id == template.id
        TemplateSourceRow(
            template: template,
            selected: selected,
            accent: theme.current.accent,
            canDelete: template.isEditable,
            onSelect: {
                vm.selectedTemplate = selected ? nil : template
            },
            onDelete: {
                if vm.selectedTemplate?.id == template.id {
                    vm.selectedTemplate = nil
                }
                templateStore.delete(id: template.id)
            })
        .contextMenu {
            if template.isEditable {
                Button(role: .destructive) {
                    if vm.selectedTemplate?.id == template.id { vm.selectedTemplate = nil }
                    templateStore.delete(id: template.id)
                } label: {
                    Label("Delete Template", systemImage: "trash")
                }
            }
        }
        .animation(.easeInOut(duration: 0.1), value: selected)
    }

    // MARK: - Commands

    private var commandsGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                subheading("Commands")
                Spacer()
                Button { showCommandImporter = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 20, height: 20)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 5))
                }
                .buttonStyle(.plain)
                .disabled(projectStore.activeProject == nil)
                .help(projectStore.activeProject == nil
                      ? "Open a project first — commands are stored in its commands/ folder"
                      : "Import a .md command")
                .padding(.trailing, 14)
            }

            if commandStore.commands.isEmpty {
                emptyHint("No commands yet — import a .md file")
                    .padding(.bottom, 12)
            } else {
                VStack(spacing: 3) {
                    ForEach(commandStore.commands) { command in
                        commandRow(command)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
    }

    @ViewBuilder
    private func commandRow(_ command: DocCommand) -> some View {
        let selected = vm.selectedCommand?.id == command.id
        Button {
            vm.selectedCommand = selected ? nil : command
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .strokeBorder(selected ? theme.current.accent : Color.secondary.opacity(0.3),
                                      lineWidth: 1.5)
                        .frame(width: 16, height: 16)
                    if selected {
                        Circle().fill(theme.current.accent).frame(width: 8, height: 8)
                    }
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(command.name)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(command.instruction)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selected ? theme.current.accent.opacity(0.08) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if command.isEditable {
                Button(role: .destructive) {
                    if vm.selectedCommand?.id == command.id { vm.selectedCommand = nil }
                    commandStore.delete(id: command.id)
                } label: {
                    Label("Delete Command", systemImage: "trash")
                }
            }
        }
        .animation(.easeInOut(duration: 0.1), value: selected)
    }

    // MARK: - Chrome

    private func subheading(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.tertiary)
            .textCase(.uppercase)
            .tracking(0.5)
            .padding(.leading, 14)
            .padding(.top, 8)
            .padding(.bottom, 4)
    }

    private func emptyHint(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.quaternary)
            .italic()
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
    }
}

// MARK: - Template row with hover delete

private struct TemplateSourceRow: View {
    let template: DocTemplate
    let selected: Bool
    let accent: Color
    let canDelete: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onSelect) {
                HStack(spacing: 10) {
                    ZStack {
                        Circle()
                            .strokeBorder(
                                selected ? accent : Color.secondary.opacity(0.3),
                                lineWidth: 1.5)
                            .frame(width: 16, height: 16)
                        if selected {
                            Circle().fill(accent).frame(width: 8, height: 8)
                        }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 4) {
                            Text(template.name)
                                .font(.callout)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            if template.isProjectTemplate {
                                Text("Project")
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(Color.secondary.opacity(0.12), in: Capsule())
                            } else if template.isBuiltin {
                                Text("Built-in")
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(Color.secondary.opacity(0.12), in: Capsule())
                            }
                        }
                        HStack(spacing: 4) {
                            Image(systemName: "doc.text")
                                .font(.system(size: 9))
                                .foregroundStyle(.tertiary)
                            Text("\(template.sections.count) sections")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if canDelete {
                Button(action: onDelete) {
                    Image(systemName: "trash")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .frame(width: 22, height: 22)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
                }
                .buttonStyle(.plain)
                .opacity(hovering ? 1 : 0)
                .help("Delete template")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(selected ? accent.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(selected ? accent.opacity(0.25) : Color.clear, lineWidth: 1)
        )
        .onHover { hovering = $0 }
    }
}
