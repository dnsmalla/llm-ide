import SwiftUI

struct LibraryView: View {
    /// Leading inset shared by EVERY file/folder row in the sidebar, so the
    /// hierarchy (section HEADER → folder → files) still reads once the rows
    /// draw their own chevron. Deeper levels indent from here, via
    /// `TreeRowLabel`'s indent guides.
    private static let treeRowInset: CGFloat = 16

    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell
    @Environment(AppEnvironment.self) private var env
    @Environment(LibraryItemStore.self) private var itemStore
    /// Handed to Extensions' host (its `serverApiVersion` gates plugin updates).
    @Environment(BackendManager.self) private var backend
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore
    @State private var vm: LibraryViewModel?
    @State private var loadError: String?
    @FocusState private var filterFocused: Bool
    /// Which folder groups are expanded per category. Persisted across relaunch
    /// (newline-joined — folder names may contain commas). Backed by AppStorage
    /// via the computed `expandedFolders` below.
    @AppStorage("library.expandedFolders") private var expandedFoldersRaw = ""
    /// Which SOURCES sub-groups (Meetings / Mail / Slack) are expanded.
    /// Absence means collapsed, so every sub-group is closed by default,
    /// matching every other section in this sidebar; the user expands what
    /// they need. Opt-in (rather than an opt-out "collapsed" set) so a
    /// source added to `SourceRegistry.all` later is closed automatically,
    /// with no key to remember to update here. Deliberately a NEW key, not
    /// a renamed/re-defaulted `library.collapsedSourceGroups`: an
    /// `@AppStorage` default only applies when the key has never been
    /// written, so an existing install that already toggled any group would
    /// keep seeing that stale default forever. Persisted across relaunch.
    @AppStorage("library.expandedSourceGroups") private var expandedSourceGroupsRaw = ""

    /// Set views over the persisted newline-joined strings. Get-modify-set works
    /// (`.insert`/`.remove`) because each has a setter; AppStorage writes are
    /// nonmutating, so the computed setters are too.
    private var expandedFolders: Set<String> {
        get { Set(expandedFoldersRaw.split(separator: "\n").map(String.init)) }
        nonmutating set { expandedFoldersRaw = newValue.joined(separator: "\n") }
    }
    private var expandedSourceGroups: Set<String> {
        get { Set(expandedSourceGroupsRaw.split(separator: "\n").map(String.init)) }
        nonmutating set { expandedSourceGroupsRaw = newValue.joined(separator: "\n") }
    }
    /// The destructive action waiting for the user's yes (connector removals;
    /// plugin / MCP / LLM source removals are confirmed by Extensions' sections).
    @State private var pendingRemoval: LibraryRemoval?
    /// Request tokens so an older list response cannot overwrite a newer one.
    @State private var loadGenerations = LibraryLoadGenerations()
    @State private var refreshingAll = false
    /// The plugin / MCP / LLM-source sections' state, owned by Extensions and
    /// reached through `ExtensionsLibraryRegistry`; nil until first appearance
    /// or when nothing is installed.
    @State private var extensions: (any ExtensionsLibraryHost)?
    /// The connectors this user has selected, plus the whole curated catalog
    /// behind the header's "Add from catalog…" sheet. Selection is what makes
    /// a connector's card appear in Settings → Connections; Meetings and Email
    /// are fixed defaults and are deliberately NOT in this catalog. Load
    /// errors surface (like `mcpPlugins`, unlike `plugins`/`llmSources`) —
    /// "nothing selected" and "the fetch failed" must not look identical.
    @State private var connectors: [ConnectorCatalogEntry] = []
    @State private var connectorCatalog: [ConnectorCatalogEntry] = []
    @State private var connectorsError: String?
    @State private var connectorMessage: String?
    @State private var showingConnectorAddSheet = false
    /// Persisted set of COLLAPSED section ids (comma-joined). Absence ⇒
    /// expanded. One uniform mechanism drives every section's chevron.
    /// Every section is seeded collapsed so the library opens in a clean,
    /// fully-closed state; the user expands what they need. Survives relaunch.
    @AppStorage("library.collapsedSections") private var collapsedSectionsRaw = "meetings,code,data,notes,plugins,llmSources,mcpPlugins,connectors"

    var body: some View {
        Group {
            if let vm {
                content(vm: vm)
            } else if let err = loadError {
                errorState(err)
            } else {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Fill the column width the parent (AppShell) assigns. A hard
        // minWidth here (was 260) fought AppShell's 180 column and the
        // oversized content got centered, clipping headers on the left.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await load() }
        .task { await loadConnectors() }
        .task { installExtensionsHost() }
        .background {
            if let extensions { ExtensionsLibraryLifecycleView(host: extensions) }
        }
        // A detail pane can change what these rows should show (connector
        // remove). It has no way to call back into this list, so it bumps
        // ShellState's token and the affected sections reload here.
        .onChange(of: shell.libraryDirtyToken) {
            Task { await loadConnectors() }
        }
        // Destructive actions (connector remove) are confirmed first; the row
        // context menus only set `pendingRemoval`.
        .confirmationDialog(
            pendingRemoval?.dialogTitle ?? "",
            isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
            titleVisibility: .visible,
            presenting: pendingRemoval
        ) { removal in
            Button(removal.confirmLabel, role: .destructive) {
                pendingRemoval = nil
                Task { await perform(removal) }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: { removal in
            Text(removal.message)
        }
        .onReceive(NotificationCenter.default.publisher(for: .meetingIndexChanged)) { _ in
            Task { @MainActor in
                // Refresh the meeting list. syncMeetingNotes is handled
                // centrally in AppShell so the NOTES section stays current
                // in all views (LibraryView, FileTreePanel, etc.).
                try? vm?.refresh()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .focusLibraryFilter)) { _ in
            filterFocused = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .revealMeetingInFinder)) { note in
            revealInFinder(id: note.object as? String)
        }
        .onReceive(NotificationCenter.default.publisher(for: .deleteMeeting)) { note in
            deleteMeeting(id: note.object as? String)
        }
        // Export from the list context menu: handled here (always mounted), not
        // in MeetingDetailView which only exists while a meeting is selected.
        .onReceive(NotificationCenter.default.publisher(for: .exportMeeting)) { note in
            presentMeetingExportPanel(id: note.object as? String, env: env)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(vm: LibraryViewModel) -> some View {
        VStack(spacing: 0) {
            searchBar(filter: Bindable(vm).filter)
            NoteIndexStatusLine()
            mainList(vm: vm)
        }
    }

    // MARK: - Section collapse state

    private var collapsedSet: Set<String> {
        Set(collapsedSectionsRaw.split(separator: ",").map(String.init))
    }

    /// Binding for a section's expanded state, persisted in
    /// `collapsedSectionsRaw`. Drives every section's collapse chevron.
    private func sectionExpanded(_ id: String) -> Binding<Bool> {
        Binding(
            get: { !collapsedSet.contains(id) },
            set: { open in
                var set = collapsedSet
                if open { set.remove(id) } else { set.insert(id) }
                collapsedSectionsRaw = set.sorted().joined(separator: ",")
            }
        )
    }

    /// Stable section id for a file-tree category (e.g. `.meetings` → "meetings").
    private func sectionId(_ category: LibraryItem.Category) -> String {
        category.rawValue.lowercased()
    }

    // MARK: - Search bar

    @ViewBuilder
    private func searchBar(filter: Binding<String>) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .font(.subheadline)
            TextField("Search meetings…", text: filter)
                .focused($filterFocused)
                .textFieldStyle(.plain)
                .font(.callout)
                .onSubmit { filterFocused = false }
            if !filter.wrappedValue.isEmpty {
                Button {
                    filter.wrappedValue = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear filter")
                .help("Clear filter")
            }
            // Manual refresh for the whole page. Every section otherwise
            // loads once per appearance (`.task`), so files changed on disk
            // and source/plugin mutations made from a detail pane stayed
            // invisible until the view was remounted.
            Button {
                Task { await refreshAll() }
            } label: {
                if refreshingAll {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise").foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .disabled(refreshingAll)
            .accessibilityLabel("Refresh library")
            .help("Reload files, plugins, LLM sources, MCP plugins, and connectors")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.bar)
        Divider()
    }

    // MARK: - Unified list

    private func mainList(vm: LibraryViewModel) -> some View {
        @Bindable var shell = shell
        return List(selection: $shell.librarySelection) {

            // ── Meeting summaries (Today / This Week / …) ─────────────
            if vm.allRows.isEmpty {
                Section {
                    emptyMeetingsRow
                }
            } else if vm.visibleRows.isEmpty {
                Section {
                    ContentUnavailableView.search
                        .listRowSeparator(.hidden)
                }
            } else {
                ForEach(vm.groupedRows, id: \.group) { bucket in
                    Section {
                        ForEach(bucket.rows, id: \.id) { row in
                            LibraryRow(row: row)
                                .tag(ShellState.LibrarySelection.meeting(row.id))
                                .transition(.asymmetric(
                                    insertion: .opacity.combined(with: .move(edge: .top)),
                                    removal: .opacity))
                        }
                    } header: {
                        dateGroupHeader(bucket.group, rows: bucket.rows)
                    }
                }
            }

            // ── Meetings (transcripts) — like NOTES but for .md files ──
            // Auto-synced from meetings/ AND accepts manually added files.
            // Right-click any transcript → Generate Note to produce its .md note.
            fileTreeSection(.meetings)

            // ── Code section (file tree) ───────────────────────────────
            fileTreeSection(.code)

            // ── Data section ──────────────────────────────────────────
            fileTreeSection(.data)

            // ── Notes section ─────────────────────────────────────────
            fileTreeSection(.notes)

            // ── Plugins / LLM Sources / MCP Plugins sections ───────────
            // Contributed by the Extensions feature (plugins, LLM-resource
            // repos, MCP servers) through `ExtensionsLibraryRegistry`.
            if let extensions {
                ForEach(ExtensionsLibrarySectionKind.allCases, id: \.self) { kind in
                    ExtensionsLibrarySectionView(request: ExtensionsLibrarySectionRequest(
                        host: extensions, kind: kind, isExpanded: sectionExpanded(kind.rawValue)))
                }
            }

            // ── Connectors section ─────────────────────────────────────
            // The curated inbound-source catalog (Box, Slack, Drive, …).
            // Adding one here is what makes its card appear in
            // Settings → Connections; Meetings and Email are fixed defaults
            // and are not part of the catalog. Removing is visibility only —
            // it never deletes fetched data.
            connectorsSection
        }
        .listStyle(.inset)
        .animation(.easeInOut(duration: 0.2), value: vm.groupedRows.map(\.group))
    }

    // MARK: - File tree section

    @ViewBuilder
    private func fileTreeSection(_ category: LibraryItem.Category) -> some View {
        if category == .meetings {
            // The "MEETINGS" folder is presented as SOURCES, split into
            // Meetings / Mail sub-groups (and, later, Slack).
            sourcesSection(category)
        } else if category.rendersNestedTree {
            // Code and LLM Doc render as real nested directory trees rather
            // than a flat one-level grouping — llm-doc's canonical layout is
            // <source>/<YYYY>/<MM>/*.md (NoteService.getMonthDir), and a flat
            // group keyed on the immediate parent collapsed that to a bare
            // month ("08").
            treeSection(category)
        } else {
            plainFileTreeSection(category)
        }
    }

    // MARK: - Nested tree sections (Code, LLM Doc)

    /// Renders a tree category's items as a recursive directory tree (the
    /// store's memoized `treeEntries(for:)` forest), flattened to the rows
    /// currently on screen. Each root shows its true subfolder hierarchy;
    /// files reuse the standard row + selection tag — including the
    /// context-menu Remove, which stays the delete affordance here because a
    /// tree's rows are not one flat level for `.onDelete` to index into.
    ///
    /// `CodeEntry.flatten` rather than `OutlineGroup`: the outline group owns
    /// both the indentation and the disclosure triangle, so its rows could
    /// never carry the Explorer's indent guides or chevron — see that method.
    @ViewBuilder
    private func treeSection(_ category: LibraryItem.Category) -> some View {
        let items = itemStore.items(for: category)
        Section {
            if sectionExpanded(sectionId(category)).wrappedValue {
                if items.isEmpty {
                    emptyRow("No \(category.sectionTitle.lowercased()) files yet")
                } else {
                    // Read the persisted set ONCE per section: its getter
                    // re-splits the whole AppStorage string, and a row-by-row
                    // read would put that on the render path per visible row.
                    let expanded = expandedFolders
                    let rows = CodeEntry.flatten(itemStore.treeEntries(for: category),
                                                 expanded: expanded)
                    ForEach(rows) { row in
                        treeEntryRow(row, tint: theme.current.tint(for: category),
                                     expanded: expanded)
                    }
                }
            }
        } header: {
            sectionHeader(category, count: items.count)
        }
    }

    /// One flattened tree row — the Explorer's `TreeRowLabel` for both a
    /// folder and a file, so the two trees read as one control.
    @ViewBuilder
    private func treeEntryRow(_ row: CodeEntry.Row, tint: Color,
                              expanded: Set<String>) -> some View {
        if let item = row.entry.item {
            LibraryFileRow(item: item, depth: row.depth)
                .tag(ShellState.LibrarySelection.file(item.url))
                .padding(.leading, Self.treeRowInset)
        } else {
            folderRow(name: row.entry.name, key: row.entry.id, depth: row.depth,
                      tint: tint, isExpanded: expanded.contains(row.entry.id))
        }
    }

    /// A folder row: the Explorer's label, toggled by a tap anywhere on it.
    ///
    /// The whole row toggles, not just the chevron — the Library has no
    /// multi-select for a body click to protect (the reason the Explorer
    /// separates the two), and its folders carry no selection tag, so this is
    /// what the `DisclosureGroup` label did before. `onToggleChevron` is left
    /// nil for exactly that reason: a chevron BUTTON on a row that already
    /// toggles would race this tap handler, and two toggles cancel out.
    private func folderRow(name: String, key: String, depth: Int, tint: Color,
                           isExpanded: Bool, icon: String? = nil,
                           badge: String? = nil) -> some View {
        TreeRowLabel(name: name,
                     isFolder: true,
                     isExpanded: isExpanded,
                     depth: depth,
                     folderTint: tint,
                     folderIcon: icon,
                     badge: badge)
            .help(name)
            // Padding BEFORE the hit shape, so the row's leading inset is part
            // of the tappable area rather than a dead strip.
            .padding(.leading, Self.treeRowInset)
            .contentShape(Rectangle())
            .onTapGesture { toggleFolder(key) }
            // A tap gesture is invisible to VoiceOver and to the keyboard, and
            // with no chevron button left on the row there is nothing else to
            // focus — the DisclosureGroup this replaced was operable by both.
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityAction { toggleFolder(key) }
    }

    /// Expand/collapse a folder. Animated to match the section headers, which
    /// the `DisclosureGroup` this replaced got for free.
    private func toggleFolder(_ key: String) {
        var set = expandedFolders
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
        withAnimation(.easeInOut(duration: 0.18)) { expandedFolders = set }
    }

    /// Standard single-list file-tree section. After the tree routing above,
    /// DATA is the only category that reaches this — Code and LLM Doc render
    /// via `treeSection`, Sources via `sourcesSection`.
    @ViewBuilder
    private func plainFileTreeSection(_ category: LibraryItem.Category) -> some View {
        let sectionItems = itemStore.items(for: category)
        Section {
          if sectionExpanded(sectionId(category)).wrappedValue {
            let looseFiles = sectionItems.filter { $0.folderOrigin == nil }
            let folderGroups = Dictionary(
                grouping: sectionItems.filter { $0.folderOrigin != nil },
                by: { $0.folderOrigin! }
            )
            let sortedFolders = folderGroups.keys.sorted()

            if sectionItems.isEmpty {
                emptyRow("No \(category.sectionTitle.lowercased()) files yet")
            } else {
                // Loose files (imported individually)
                ForEach(looseFiles) { item in
                    LibraryFileRow(item: item)
                        .tag(ShellState.LibrarySelection.file(item.url))
                        .padding(.leading, Self.treeRowInset)
                }
                // No `.onDelete`: `itemStore.remove` deletes the file from disk, and
                // the Delete key / Edit ▸ Delete used to do that with no prompt,
                // while the row's context menu asks first. That menu is the one
                // deliberate path.

                // Folder groups (imported via "Add Folder"). A folder row plus
                // its children as SIBLING rows rather than a DisclosureGroup:
                // that control draws its own triangle and indentation, which
                // is what kept these rows from matching the Explorer tree.
                let expanded = expandedFolders
                ForEach(sortedFolders, id: \.self) { folderName in
                    let folderItems = folderGroups[folderName] ?? []
                    let key = "\(category.rawValue):\(folderName)"
                    folderRow(name: folderName, key: key, depth: 0,
                              tint: theme.current.tint(for: category),
                              isExpanded: expanded.contains(key))
                    if expanded.contains(key) {
                        ForEach(folderItems) { item in
                            LibraryFileRow(item: item, depth: 1)
                                .tag(ShellState.LibrarySelection.file(item.url))
                                .padding(.leading, Self.treeRowInset)
                        }
                    }
                }
            }
          }

        } header: {
            sectionHeader(category, count: sectionItems.count)
        }
    }

    // MARK: - Sources section (Meetings / Mail / Slack)

    /// The `.meetings` folder rendered as SOURCES: a single header over one
    /// sub-group per registered `InputSource` (captured Meetings, ingested
    /// Mail, …). Every source in `SourceRegistry.all` is shown, so the
    /// structure reads as intentionally extensible: a new input (e.g. Slack) is
    /// one registry entry, no view change. Items partition by `sourceId`.
    @ViewBuilder
    private func sourcesSection(_ category: LibraryItem.Category) -> some View {
        let all = itemStore.items(for: category)
        let grouped = Dictionary(grouping: all) { $0.sourceId ?? MeetingSource().id }
        Section {
            if sectionExpanded(sectionId(category)).wrappedValue {
                ForEach(SourceRegistry.all, id: \.id) { source in
                    sourceSubGroup(source: source, items: grouped[source.id] ?? [],
                                   tint: theme.current.tint(for: category))
                }
            }
        } header: {
            sectionHeader(category, count: all.count)
        }
    }

    /// One collapsible SOURCES sub-group, rendered as a folder row in the same
    /// tree as every other section — but keeping the source's own symbol
    /// (`folderIcon`), because Meetings and Mail are not directories and
    /// reading as one would lose what they are. Defaults to collapsed and
    /// shows a muted empty state when it has no files.
    ///
    /// Files render as the source's real on-disk tree
    /// (`source/<source dir>/<YYYY>/<MM>/…`, sub-group-relative so the tree
    /// starts at the year) — the same shared forest Code and LLM Doc use, one
    /// level deeper so it nests under this row. Delete is via the row context
    /// menu (this isn't a ForEach over one level, so no swipe-to-delete).
    @ViewBuilder
    private func sourceSubGroup(source: InputSource, items: [LibraryItem],
                                tint: Color) -> some View {
        let stateKey = "sources:\(source.id)"
        let isExpanded = expandedSourceGroups.contains(stateKey)
        // A folder row like every other, but toggled through its OWN
        // persisted set (`expandedSourceGroups`) — see that property.
        TreeRowLabel(name: source.displayName,
                     isFolder: true,
                     isExpanded: isExpanded,
                     depth: 0,
                     folderTint: tint,
                     folderIcon: source.icon,
                     badge: items.isEmpty ? nil : "\(items.count)")
            .help(source.displayName)
            .padding(.leading, Self.treeRowInset)
            .contentShape(Rectangle())
            .onTapGesture { toggleSourceGroup(stateKey) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityAction { toggleSourceGroup(stateKey) }

        if isExpanded {
            if items.isEmpty {
                // Lines this row's icon up with the depth-1 file icons it
                // stands in for: one 14pt indent guide, the 10pt chevron
                // stand-in, and the 4pt gap before each (see TreeRowLabel).
                emptyRow(source.emptyText, icon: source.icon,
                         leading: Self.treeRowInset + 32)
            } else {
                let expanded = expandedFolders
                let rows = CodeEntry.flatten(itemStore.sourceTreeEntries(forSourceId: source.id),
                                             expanded: expanded,
                                             depth: 1)
                ForEach(rows) { row in
                    treeEntryRow(row, tint: tint, expanded: expanded)
                }
            }
        }
    }

    private func toggleSourceGroup(_ key: String) {
        var set = expandedSourceGroups
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
        withAnimation(.easeInOut(duration: 0.18)) { expandedSourceGroups = set }
    }

    // MARK: - Unified section header

    /// The one header style used by EVERY Library section (see
    /// `LibrarySectionHeader`, which Extensions' sections use too).
    private func unifiedSectionHeader<Trailing: View>(
        id: String, title: String, icon: String, tint: Color, count: Int,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) -> some View {
        LibrarySectionHeader(title: title, icon: icon, tint: tint, count: count,
                             isExpanded: sectionExpanded(id), trailing: trailing)
    }

    /// File-tree section header (Sources/Code/Data/LLM Doc): unified header with
    /// the category's palette tint and the "Add File / Add Folder" menu.
    private func sectionHeader(_ category: LibraryItem.Category, count: Int) -> some View {
        unifiedSectionHeader(
            id: sectionId(category),
            title: category.sectionTitle,
            icon: category.icon,
            tint: theme.current.tint(for: category),
            count: count
        ) {
            addMenu(for: category)
        }
    }

    /// The "+" add menu shown on file-tree section headers.
    @ViewBuilder
    private func addMenu(for category: LibraryItem.Category) -> some View {
        Menu {
            Button { pickFile(for: category) } label: {
                Label("Add File", systemImage: "doc.badge.plus")
            }
            .disabled(projectStore.activeProject == nil)
            .help(projectStore.activeProject == nil ? "Open a project first" : "")
            Button { pickFolder(for: category) } label: {
                Label("Add Folder", systemImage: "folder.badge.plus")
            }
            .disabled(projectStore.activeProject == nil)
            .help(projectStore.activeProject == nil ? "Open a project first" : "")
            if category == .meetings {
                Divider()
                Button {
                    // Jump to Settings → Connections (the inputs hub) and
                    // expand it via the deep-link the section listens for.
                    shell.section = .settings
                    NotificationCenter.default.post(name: .scrollSettingsToCard,
                                                    object: SettingsAnchor.connections)
                } label: {
                    Label("Connect a source…", systemImage: "tray.and.arrow.down")
                }
                Button {
                    NSWorkspace.shared.open(
                        URL(fileURLWithPath: env.meetingsFolder.path))
                } label: {
                    Label("Reveal Folder in Finder", systemImage: "folder")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(theme.current.tint(for: category).opacity(0.6))
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: 20)
        .help(category == .meetings ? "Add transcript, connect a source, or reveal folder" : "Add file or folder")
    }

    /// Consistent muted empty/placeholder row used across every section.
    private func emptyRow(_ text: String, icon: String = "tray", leading: CGFloat = 0) -> some View {
        LibraryEmptyRow(text: text, icon: icon, leading: leading)
    }

    private func pickFile(for category: LibraryItem.Category) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.message = "Choose files to add to \(category.sectionTitle)"
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { itemStore.add(url: url, category: category) }
    }

    private func pickFolder(for category: LibraryItem.Category) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder — all files inside will be added to \(category.sectionTitle)"
        panel.prompt = "Add Folder"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        itemStore.addFolder(url: url, category: category)
    }

    // MARK: - Empty / error states

    private var emptyMeetingsRow: some View {
        VStack(spacing: 8) {
            Image(systemName: "waveform.and.mic")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No Meetings Yet")
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text("Press ⌘N or click **Record** to capture your first meeting.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
        .listRowSeparator(.hidden)
    }

    private func errorState(_ msg: String) -> some View {
        ContentUnavailableView {
            Label("Couldn't Load Library", systemImage: "exclamationmark.triangle")
        } description: {
            Text(msg)
        } actions: {
            Button("Retry") { Task { await load() } }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Actions

    /// The search bar's refresh button: re-run every section's loader, same
    /// set the `.task` modifiers fire on first appearance. Sequential on
    /// purpose — they share the API client and each is fast local I/O.
    ///
    /// Unlike first appearance, a manual refresh must also RE-SCAN the
    /// folders, not just re-read what was indexed before: the loaders below
    /// only re-query `meetings_index` and the item store's last walk, so
    /// files added/changed on disk since then stayed invisible — the exact
    /// gap this button was added to close. The disk scans run first so
    /// `load()` reads the freshly indexed rows.
    private func refreshAll() async {
        refreshingAll = true
        defer { refreshingAll = false }
        // Off-main (fullScan blocks on the directory walk); safe —
        // FolderIndexer is Sendable and fullScan is lock-serialized. Its
        // completing `.meetingIndexChanged` post is what fans out the
        // file-tree refresh too: AppShell's handler runs
        // `itemStore.rescanAsync()`, covering NOTES/MEETINGS/CODE and the
        // "Add Folder" external references — so no second walk here.
        let indexer = env.indexer
        await Task.detached(priority: .userInitiated) {
            try? indexer.fullScan()
        }.value
        await load()
        await extensions?.refresh()
        await loadConnectors()
    }

    /// Builds Extensions' host once per appearance of this view.
    private func installExtensionsHost() {
        guard extensions == nil else { return }
        extensions = ExtensionsLibraryRegistry.shared.makeHost(
            ExtensionsLibraryRequest(api: api, shell: shell, backend: backend))
    }

    private func load() async {
        do {
            let model = LibraryViewModel(index: env.index)
            try model.refresh()
            self.vm = model
            // Note: NOTES and MEETINGS sync is handled centrally by AppShell
            // (initEnv + .meetingIndexChanged handler) so every view always
            // reflects the current folders — no per-view sync needed here.
        } catch {
            loadError = "Could not load library: \(error.localizedDescription)"
        }
    }

    /// Run the removal the user just confirmed.
    private func perform(_ removal: LibraryRemoval) async {
        switch removal {
        case .connector(let id, _): await removeConnector(id)
        case .sourceDisconnect:
            // Disconnect is confirmed inside the source sheets, which own the
            // vault keys to delete; nothing in the Library list sets it.
            break
        }
    }
    /// After an install / import / remove / reload: the plugin set changed, so
    // MARK: - Connectors

    @ViewBuilder
    private var connectorsSection: some View {
        Section {
            if sectionExpanded("connectors").wrappedValue {
                if let connectorsError {
                    HStack(spacing: 6) {
                        Text(connectorsError).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Button("Retry") { Task { await loadConnectors() } }
                            .font(.caption)
                    }
                    .padding(.vertical, 2)
                } else if connectors.isEmpty {
                    emptyRow("No connectors added yet.", icon: "point.3.connected.trianglepath.dotted")
                } else {
                    ForEach(connectors) { entry in
                        ConnectorRow(entry: entry)
                            .tag(ShellState.LibrarySelection.connector(entry.id))
                            .contextMenu {
                                Button(role: .destructive) {
                                    pendingRemoval = .connector(id: entry.id, name: entry.name)
                                } label: { Label("Remove", systemImage: "trash") }
                            }
                    }
                }
            }
        } header: {
            connectorsHeader
        }
    }

    /// Section header row with the "Add from catalog…" menu.
    @ViewBuilder
    private var connectorsHeader: some View {
        unifiedSectionHeader(
            id: "connectors", title: "Connectors",
            icon: "point.3.connected.trianglepath.dotted",
            tint: theme.current.info, count: connectors.count
        ) {
            Menu {
                Button {
                    showingConnectorAddSheet = true
                } label: { Label("Add from catalog…", systemImage: "plus.circle") }
                Divider()
                Button {
                    // The connectors' own configuration (credentials, folders)
                    // lives in Settings → Connections; this section only
                    // decides which cards appear there.
                    shell.section = .settings
                    NotificationCenter.default.post(name: .scrollSettingsToCard,
                                                    object: SettingsAnchor.connections)
                } label: { Label("Configure in Settings…", systemImage: "gearshape") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.info.opacity(0.6))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Add a connector")
        }
        .alert("Connector", isPresented: Binding(
            get: { connectorMessage != nil },
            set: { if !$0 { connectorMessage = nil } }
        )) {
            Button("OK") { connectorMessage = nil }
        } message: {
            Text(connectorMessage ?? "")
        }
        .sheet(isPresented: $showingConnectorAddSheet) {
            ConnectorAddSheet(catalog: connectorCatalog) { entry in
                Task { await addConnector(entry) }
            }
            .environmentObject(theme)
        }
    }

    /// Load the selected list AND the catalog. Selected-list failures surface
    /// (see `connectors`' comment); a catalog failure is best-effort — it only
    /// empties the add sheet, and reporting it over the selection list would
    /// bury the more important state.
    private func loadConnectors() async {
        let token = loadGenerations.begin(.connectors)
        do {
            let fetched = try await api.listConnectors()
            guard loadGenerations.isCurrent(token, for: .connectors) else { return }
            connectors = fetched
            connectorsError = nil
        } catch {
            guard loadGenerations.isCurrent(token, for: .connectors) else { return }
            connectorsError = error.localizedDescription
        }
        let catalog = try? await api.fetchConnectorCatalog()
        guard loadGenerations.isCurrent(token, for: .connectors) else { return }
        connectorCatalog = catalog ?? connectorCatalog
    }

    private func addConnector(_ entry: ConnectorCatalogEntry) async {
        do {
            try await api.addConnector(id: entry.id)
            connectorMessage = entry.pipelineReady
                ? "Added \(entry.name). Configure it in Settings → Connections."
                : "Added \(entry.name). Its fetch pipeline lands in an upcoming update — the selection is saved."
            await loadConnectors()
        } catch {
            connectorMessage = error.localizedDescription
        }
    }

    private func removeConnector(_ id: String) async {
        do {
            try await api.removeConnector(id: id)
            if case .connector(let sel) = shell.librarySelection, sel == id {
                shell.librarySelection = nil
            }
            await loadConnectors()
        } catch {
            connectorMessage = error.localizedDescription
        }
    }

    // MARK: - Date group header

    private func dateGroupHeader(
        _ group: LibraryViewModel.DateGroup,
        rows: [MeetingIndex.Row]
    ) -> some View {
        HStack(spacing: 0) {
            Text(group.rawValue)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Menu {
                Button(role: .destructive) {
                    deleteAllMeetings(rows)
                } label: {
                    Label("Remove All \(group.rawValue) from List", systemImage: "minus.circle")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
        }
    }

    // MARK: - Delete helpers

    private func deleteAllMeetings(_ rows: [MeetingIndex.Row]) {
        for row in rows { deleteMeeting(id: row.id) }
    }

    private func revealInFinder(id: String?) {
        guard let id, let row = try? env.index.get(id: id) else { return }
        let url = env.notesConfig.currentFolder.appendingPathComponent(row.path)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func deleteMeeting(id: String?) {
        guard let id else { return }
        // Hide from the list ONLY — the .md file stays on disk and remains
        // visible in the MEETINGS transcript section. To delete the physical
        // file, use "Delete Transcript" in the MEETINGS file tree section.
        // A tombstone, not a row delete: the folder indexer re-adds every
        // .md without a row, so deleting the row brought the meeting back on
        // the next scan.
        try? env.index.hide(id: id)
        // Clear the detail selection if this meeting was open.
        if case .meeting(let sel) = shell.librarySelection, sel == id {
            shell.librarySelection = nil
        }
        // Refresh the list.
        try? vm?.refresh()
    }
}

/// One quiet line when some notes could not be indexed (counts only, no alert). Empty when none.
private struct NoteIndexStatusLine: View {
    @ObservedObject private var center = NoteIndexStatusCenter.shared

    var body: some View {
        if let text = center.summary {
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .accessibilityIdentifier("library.noteIndexStatus")
        }
    }
}
