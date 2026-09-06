import SwiftUI

struct DocGenSourcePanel: View {
    @ObservedObject var vm: DocGenViewModel
    let api: LlmIdeAPIClient

    @EnvironmentObject private var theme: ThemeStore
    @Environment(LibraryItemStore.self) private var itemStore

    /// Persisted set of EXPANDED section ids (comma-joined). Absence ⇒
    /// collapsed, so this panel opens fully closed — the user expands what
    /// they need. Opt-in (rather than an opt-out "collapsed" set seeded with
    /// today's section ids) so a section added later is closed automatically
    /// with no key to remember to update here — see `LibraryView`'s
    /// `expandedSourceGroups` for the same reasoning applied to an
    /// already-shipped key, where a stale seeded default silently failed to
    /// take effect on any install that had already toggled a section.
    @AppStorage("docgen.expandedSections") private var expandedSectionsRaw = ""

    private var expandedSet: Set<String> {
        Set(expandedSectionsRaw.split(separator: ",").map(String.init))
    }

    /// Binding for a section's expanded state, persisted in
    /// `expandedSectionsRaw`. Drives every section's collapse chevron.
    private func sectionExpanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { expandedSet.contains(id) },
            set: { open in
                var set = expandedSet
                if open { set.insert(id) } else { set.remove(id) }
                expandedSectionsRaw = set.sorted().joined(separator: ",")
            }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    DocGenTemplateSection(vm: vm, isExpanded: sectionExpanded("template"))
                    Divider().padding(.vertical, 6)
                    notesSection
                    Divider().padding(.vertical, 6)
                    dataSection
                    Divider().padding(.vertical, 6)
                    sourcesSection
                }
                .padding(.bottom, 12)
            }

            Divider()
            footer
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - LLM Doc section

    private var notesSection: some View {
        let items = itemStore.items(for: .notes)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHeader(id: "notes", title: "LLM Doc", icon: "note.text", color: .blue)
                Spacer()
            }

            if sectionExpanded("notes").wrappedValue {
                if items.isEmpty {
                    emptyHint("No LLM Docs in Library yet")
                } else {
                    ForEach(items) { item in
                        fileRow(item: item, iconColor: .blue)
                    }
                }
            }
        }
    }

    // MARK: - Data section

    private var dataSection: some View {
        let items = itemStore.items(for: .data)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHeader(id: "data", title: "Data", icon: "tablecells", color: .purple)
                Spacer()
            }

            if sectionExpanded("data").wrappedValue {
                if items.isEmpty {
                    emptyHint("No data files in Library yet")
                } else {
                    ForEach(items) { item in
                        fileRow(item: item, iconColor: .purple)
                    }
                }
            }
        }
    }

    // MARK: - Sources (meetings) section

    private var sourcesSection: some View {
        let items = itemStore.items(for: .meetings)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHeader(id: "sources", title: "Sources", icon: "waveform.and.mic", color: .indigo)
                Spacer()
            }
            if sectionExpanded("sources").wrappedValue {
                if items.isEmpty {
                    emptyHint("No meeting transcripts in Library yet")
                } else {
                    ForEach(items) { item in
                        fileRow(item: item, iconColor: .indigo)
                    }
                }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 7) {
            Image(systemName: "books.vertical")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text("Add LLM Docs, data, or sources from the Library")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Reusable components

    /// Collapse chevron + icon + label, matching the Library sidebar's
    /// section-header convention. Tapping toggles `sectionExpanded(id)`.
    private func sectionHeader(id: String, title: String, icon: String, color: Color) -> some View {
        let isExpanded = sectionExpanded(id)
        return Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                isExpanded.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded.wrappedValue ? 90 : 0))
                    .frame(width: 10)
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(color.opacity(0.9))
                SectionLabel(title, size: 10)
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded.wrappedValue ? "Collapse \(title)" : "Expand \(title)")
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

                if vm.unreadableSourceNames.contains(item.name) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(theme.current.warning)
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
