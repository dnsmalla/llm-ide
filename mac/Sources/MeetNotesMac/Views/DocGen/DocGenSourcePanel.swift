import SwiftUI

struct DocGenSourcePanel: View {
    @ObservedObject var vm: DocGenViewModel
    let api: MeetNotesAPIClient

    @EnvironmentObject private var templateStore: DocTemplateStore
    @EnvironmentObject private var theme: ThemeStore
    @Environment(LibraryItemStore.self) private var itemStore
    @State private var showFileImporter = false
    @State private var importCategory: LibraryItem.Category = .notes
    @State private var showTemplateImporter = false
    @State private var showTemplateManager = false
    @State private var failedFileIDs: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    templateSection
                    Divider().padding(.vertical, 6)
                    notesSection
                    Divider().padding(.vertical, 6)
                    dataSection
                }
                .padding(.bottom, 12)
            }

            Divider()
            footer
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $showTemplateManager) {
            DocTemplateManagerSheet()
                .environmentObject(templateStore)
                .frame(minWidth: 580, minHeight: 500)
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                for url in urls { itemStore.add(url: url, category: importCategory) }
            }
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
    }

    // MARK: - Template section

    private var templateSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack {
                sectionHeader(title: "Template", icon: "doc.badge.gearshape", color: theme.current.accent)
                Spacer()
                if !templateStore.templates.isEmpty {
                    Button {
                        showTemplateImporter = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 20, height: 20)
                            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 5))
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 14)
                    .padding(.top, 10)
                }
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
        HStack(spacing: 8) {
            // Radio + label — tappable
            Button {
                vm.selectedTemplate = selected ? nil : template
            } label: {
                HStack(spacing: 10) {
                    ZStack {
                        Circle()
                            .strokeBorder(
                                selected ? theme.current.accent : Color.secondary.opacity(0.3),
                                lineWidth: 1.5)
                            .frame(width: 16, height: 16)
                        if selected {
                            Circle()
                                .fill(theme.current.accent)
                                .frame(width: 8, height: 8)
                        }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(template.name)
                            .font(.callout)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
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

            // Delete button
            Button {
                if vm.selectedTemplate?.id == template.id {
                    vm.selectedTemplate = nil
                }
                templateStore.delete(id: template.id)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .frame(width: 22, height: 22)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
            }
            .buttonStyle(.plain)
            .opacity(0)
            .overlay(
                // Show delete only on hover using a clear overlay trick
                Color.clear.contentShape(Rectangle())
            )
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            selected ? theme.current.accent.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    selected ? theme.current.accent.opacity(0.25) : Color.clear,
                    lineWidth: 1)
        )
        .contextMenu {
            Button(role: .destructive) {
                if vm.selectedTemplate?.id == template.id { vm.selectedTemplate = nil }
                templateStore.delete(id: template.id)
            } label: {
                Label("Delete Template", systemImage: "trash")
            }
        }
        .animation(.easeInOut(duration: 0.1), value: selected)
    }

    // MARK: - Notes section

    private var notesSection: some View {
        let items = itemStore.items(for: .notes)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHeader(title: "Notes", icon: "note.text", color: .blue)
                Spacer()
                addButton(for: .notes)
            }

            if items.isEmpty {
                emptyHint("No notes imported yet")
            } else {
                ForEach(items) { item in
                    fileRow(item: item, iconColor: .blue)
                }
            }
        }
    }

    // MARK: - Data section

    private var dataSection: some View {
        let items = itemStore.items(for: .data)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHeader(title: "Data", icon: "tablecells", color: .purple)
                Spacer()
                addButton(for: .data)
            }

            if items.isEmpty {
                emptyHint("No data files imported yet")
            } else {
                ForEach(items) { item in
                    fileRow(item: item, iconColor: .purple)
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        Menu {
            Button {
                importCategory = .notes
                showFileImporter = true
            } label: { Label("Import into Notes", systemImage: "note.text") }

            Button {
                importCategory = .data
                showFileImporter = true
            } label: { Label("Import into Data", systemImage: "tablecells") }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.current.accent)
                Text("Add file or folder")
                    .font(.callout)
                    .foregroundStyle(.primary)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
    }

    // MARK: - Reusable components

    private func sectionHeader(title: String, icon: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(color.opacity(0.9))
            SectionLabel(title, size: 10)
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 6)
    }

    private func addButton(for category: LibraryItem.Category) -> some View {
        Button {
            importCategory = category
            showFileImporter = true
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .padding(.trailing, 14)
        .padding(.top, 10)
    }

    private func emptyHint(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.quaternary)
            .italic()
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
    }

    @ViewBuilder
    private func fileRow(item: LibraryItem, iconColor: Color) -> some View {
        let source = DocGenSource.file(url: item.url, name: item.name)
        let selected = vm.selectedSources.contains(source)

        Button {
            if selected { vm.selectedSources.remove(source) }
            else { vm.selectedSources.insert(source) }
        } label: {
            HStack(spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(selected ? theme.current.accent : Color(nsColor: .windowBackgroundColor))
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(
                            selected ? theme.current.accent : Color.secondary.opacity(0.3),
                            lineWidth: 1.2)
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .black))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 15, height: 15)

                Image(systemName: iconForExt(item.ext))
                    .font(.system(size: 11))
                    .foregroundStyle(selected ? iconColor : Color.secondary.opacity(0.5))
                    .frame(width: 14)

                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let folder = item.folderOrigin {
                        Text(folder)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)

                if failedFileIDs.contains(item.id) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .help("Could not read this file")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .background(selected ? theme.current.accent.opacity(0.07) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func iconForExt(_ ext: String) -> String {
        switch ext {
        case "md", "txt":          return "doc.text"
        case "pdf":                return "doc.richtext"
        case "csv", "xlsx", "xls": return "tablecells"
        case "json":               return "curlybraces"
        default:                   return "doc"
        }
    }
}
