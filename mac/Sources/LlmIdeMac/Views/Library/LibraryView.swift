import SwiftUI

struct LibraryView: View {
    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell
    @Environment(AppEnvironment.self) private var env
    @Environment(LibraryItemStore.self) private var itemStore
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
    /// Installed plugins for the current user. Loaded once on appear
    /// and refreshed when the user (re-)opens Library. Failures are
    /// silent — the sidebar just shows an empty Plugins section.
    @State private var plugins: [PluginInfo] = []
    @State private var showingGitInstallSheet = false
    @State private var showingClaudeImportSheet = false
    @State private var pluginInstallMessage: String?
    /// Held when an install hits "already installed" (409): re-runs the same
    /// install with replace=true if the user confirms. Replaces the old
    /// "go to Settings → Plugins to overwrite" punt now that management is
    /// wholly in Library.
    @State private var pendingReplaceInstall: ((Bool) async throws -> PluginInstallResponse)?
    /// Registered LLM sources for the current user. Loaded once on
    /// appear and refreshed after any add/toggle/update/remove — same
    /// pattern as `plugins`.
    @State private var llmSources: [LlmIdeAPIClient.LlmSourceInfo] = []
    @State private var showingLlmSourceAddSheet = false
    @State private var llmSourceMessage: String?
    /// Registered MCP plugins for the current user. Loaded once on appear
    /// and refreshed after any add/consent/toggle/remove — same pattern as
    /// `llmSources`, except load/refresh surface errors instead of
    /// swallowing them: an empty section from a real fetch failure (e.g. the
    /// server down) looks identical to "nothing registered yet" otherwise,
    /// which hides an actionable problem from the user.
    @State private var mcpPlugins: [LlmIdeAPIClient.McpPluginInfo] = []
    @State private var mcpPluginsError: String?
    @State private var mcpPluginMessage: String?
    @State private var mcpClaudeSources: [LlmIdeAPIClient.ClaudeMcpSource] = []
    /// Persisted set of COLLAPSED section ids (comma-joined). Absence ⇒
    /// expanded. One uniform mechanism drives every section's chevron.
    /// Every section is seeded collapsed so the library opens in a clean,
    /// fully-closed state; the user expands what they need. Survives relaunch.
    @AppStorage("library.collapsedSections") private var collapsedSectionsRaw = "meetings,code,data,notes,plugins,llmSources,mcpPlugins"

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
        .task { await loadPlugins() }
        .task { await loadLlmSources() }
        .task { await loadMcpPlugins() }
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
            // Right-click any transcript → Generate Note to produce a .docx.
            fileTreeSection(.meetings)

            // ── Code section (file tree) ───────────────────────────────
            fileTreeSection(.code)

            // ── Data section ──────────────────────────────────────────
            fileTreeSection(.data)

            // ── Notes section ─────────────────────────────────────────
            fileTreeSection(.notes)

            // ── Plugins section ───────────────────────────────────────
            // User-scoped — shown regardless of active project. Install /
            // import / reload live in this section's header menu (the ⊕);
            // uninstall in each row's context menu. (Plugin management is
            // wholly here now — there is no Settings → Plugins.)
            // Agents / Skills browse UIs were removed; skills install into
            // the project via the central kit, and the Code Assistant "/"
            // menu still discovers them.
            pluginsSection

            // ── LLM Sources section ────────────────────────────────────
            // Registered LLM-resource repos (builtin .skills + user-added
            // git/local sources), each contributing any mix of skills (chat
            // "/" menu discovery via /kb/agent/skill-library), agents, and
            // hooks. Agents/hooks are catalogued for display only — never
            // invoked/executed. See
            // docs/superpowers/specs/2026-08-11-skills-sources-design.md and
            // docs/superpowers/specs/2026-08-12-llm-sources-rename-and-expand.md.
            llmSourcesSection

            // ── MCP Plugins section ────────────────────────────────────
            // Servers imported from ~/.claude.json or registered manually,
            // gated by per-user consent + enable before they reach the
            // Claude CLI's --mcp-config. See
            // docs/superpowers/specs/2026-08-12-mcp-plugin-runtime-design.md.
            mcpPluginsSection
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
        } else if category == .code {
            // Code renders as a real nested directory tree (one node per
            // repo/root) rather than a flat one-level grouping.
            codeTreeSection(category)
        } else {
            plainFileTreeSection(category)
        }
    }

    // MARK: - Code section (nested tree)

    /// Renders `.code` items as a recursive directory tree via `OutlineGroup`,
    /// which handles expand/collapse and nesting for us. Each repo/root shows
    /// its true subfolder hierarchy; files reuse the standard row + selection
    /// tag. Swipe-to-delete isn't offered here (OutlineGroup isn't a ForEach) —
    /// acceptable since code files are in-place repo references.
    @ViewBuilder
    private func codeTreeSection(_ category: LibraryItem.Category) -> some View {
        let items = itemStore.items(for: category)
        Section {
            if sectionExpanded(sectionId(category)).wrappedValue {
                if items.isEmpty {
                    emptyRow("No \(category.sectionTitle.lowercased()) files yet")
                } else {
                    OutlineGroup(CodeEntry.build(from: items), children: \.children) { entry in
                        codeEntryRow(entry, tint: theme.current.tint(for: category))
                    }
                }
            }
        } header: {
            sectionHeader(category, count: items.count)
        }
    }

    @ViewBuilder
    private func codeEntryRow(_ entry: CodeEntry, tint: Color) -> some View {
        if let item = entry.item {
            LibraryFileRow(item: item)
                .tag(ShellState.LibrarySelection.file(item.url))
        } else {
            HStack(spacing: 5) {
                Image(systemName: "folder.fill")
                    .font(Typography.filename)
                    .foregroundStyle(tint)
                Text(entry.name)
                    .font(Typography.filename)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            .help(entry.name)
        }
    }

    /// Standard single-list file-tree section (Code / Data / Notes).
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
                }
                .onDelete { offsets in
                    let toDelete = offsets.map { looseFiles[$0] }
                    toDelete.forEach { itemStore.remove(id: $0.id) }
                }

                // Folder groups (imported via "Add Folder")
                ForEach(sortedFolders, id: \.self) { folderName in
                    let folderItems = folderGroups[folderName] ?? []
                    let key = "\(category.rawValue):\(folderName)"
                    let isExpanded = Binding(
                        get: { expandedFolders.contains(key) },
                        set: { open in
                            if open { expandedFolders.insert(key) }
                            else     { expandedFolders.remove(key) }
                        }
                    )
                    DisclosureGroup(isExpanded: isExpanded) {
                        ForEach(folderItems) { item in
                            LibraryFileRow(item: item)
                                .tag(ShellState.LibrarySelection.file(item.url))
                                .padding(.leading, 6)
                        }
                        .onDelete { offsets in
                            let toDelete = offsets.map { folderItems[$0] }
                            toDelete.forEach { itemStore.remove(id: $0.id) }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "folder.fill")
                                .font(Typography.filename)
                                .foregroundStyle(theme.current.tint(for: category))
                            Text(folderName)
                                .font(Typography.filename)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                        }
                        .help(folderName)
                    }
                    // Indent the whole disclosure row — including the ">" chevron —
                    // two spaces in from the section header so the tree hierarchy
                    // (HEADER → ">" folder → files) reads clearly.
                    .padding(.leading, 16)
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

    /// One collapsible SOURCES sub-group. Mirrors the folder-group
    /// DisclosureGroup styling used elsewhere in the file tree; defaults to
    /// collapsed and shows a muted empty state when it has no files.
    ///
    /// Note: items are shown as a flat list here — unlike the plain file-tree
    /// sections, `folderOrigin` nesting is intentionally not reproduced, since
    /// auto-synced meeting/mail files sit directly in `meetings/`.
    @ViewBuilder
    private func sourceSubGroup(source: InputSource, items: [LibraryItem],
                                tint: Color) -> some View {
        let stateKey = "sources:\(source.id)"
        let isExpanded = Binding(
            get: { expandedSourceGroups.contains(stateKey) },
            set: { open in
                if open { expandedSourceGroups.insert(stateKey) }
                else     { expandedSourceGroups.remove(stateKey) }
            }
        )
        DisclosureGroup(isExpanded: isExpanded) {
            if items.isEmpty {
                emptyRow(source.emptyText, icon: source.icon, leading: 6)
            } else {
                ForEach(items) { item in
                    LibraryFileRow(item: item)
                        .tag(ShellState.LibrarySelection.file(item.url))
                        .padding(.leading, 6)
                }
                .onDelete { offsets in
                    let toDelete = offsets.map { items[$0] }
                    toDelete.forEach { itemStore.remove(id: $0.id) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: source.icon)
                    .font(Typography.filename)
                    .foregroundStyle(tint)
                Text(source.displayName)
                    .font(Typography.filename)
                    .foregroundStyle(.primary)
                if !items.isEmpty {
                    Text("\(items.count)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.leading, 16)
    }

    // MARK: - Unified section header

    /// The one header style used by EVERY Library section: a collapse chevron,
    /// an 18×18 tinted icon chip, an uppercase label, a count pill, and an
    /// optional trailing control (an "+" / install menu). `tint` is always
    /// palette-derived so the whole sidebar adapts across Dark/Light/Midnight.
    ///
    /// Tapping anywhere on the label area toggles the section (large hit
    /// target); the trailing control sits outside the toggle button.
    private func unifiedSectionHeader<Trailing: View>(
        id: String, title: String, icon: String, tint: Color, count: Int,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        let isExpanded = sectionExpanded(id)
        return HStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.wrappedValue.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded.wrappedValue ? 90 : 0))
                        .frame(width: 10)
                    Image(systemName: icon)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(tint)
                        .frame(width: 18, height: 18)
                        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                    Text(title)
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(tint)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    if count > 0 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(tint.opacity(0.6))
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isExpanded.wrappedValue ? "Collapse \(title)" : "Expand \(title)")

            trailing()
        }
        // Breathing room above each section groups it visually (Finder-style)
        // and stops the colored uppercase label from crowding the rows beneath.
        .padding(.top, 12)
        .padding(.bottom, 3)
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
                    NotificationCenter.default.post(name: .scrollSettingsToCard, object: "connections")
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
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(Typography.fileMeta)
                .foregroundStyle(.tertiary)
            Text(text)
                .font(Typography.fileMeta)
                .foregroundStyle(.tertiary)
        }
        .listRowSeparator(.hidden)
        .padding(.vertical, 2)
        .padding(.leading, leading)
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
        expandedFolders.insert("\(category.rawValue):\(url.lastPathComponent)")
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

    @ViewBuilder
    private var pluginsSection: some View {
        Section {
            if sectionExpanded("plugins").wrappedValue {
                if plugins.isEmpty {
                    emptyRow("No plugins installed yet — install from .zip or a Git URL.",
                             icon: "puzzlepiece.extension")
                } else {
                    ForEach(plugins) { p in
                        PluginLibraryRow(plugin: p)
                            .tag(ShellState.LibrarySelection.plugin(p.name))
                            .contextMenu {
                                Button(role: .destructive) {
                                    Task { await uninstall(p) }
                                } label: { Label("Uninstall", systemImage: "trash") }
                            }
                    }
                }
            }
        } header: {
            pluginsHeader
        }
    }

    /// Section header row with the "+" install menu.
    @ViewBuilder
    private var pluginsHeader: some View {
        unifiedSectionHeader(
            id: "plugins", title: "Plugins", icon: "puzzlepiece.extension",
            tint: theme.current.categoryTeal, count: plugins.count
        ) {
            // Right: install menu — same frame/font as the + buttons above.
            Menu {
                Button {
                    Task { await installFromZip() }
                } label: { Label("Install from .zip…", systemImage: "doc.zipper") }
                Button {
                    showingGitInstallSheet = true
                } label: { Label("Install from Git URL…", systemImage: "link") }
                Button {
                    showingClaudeImportSheet = true
                } label: { Label("Import from Claude Code…", systemImage: "arrow.down.circle") }
                Divider()
                Button {
                    revealPluginsFolder()
                } label: { Label("Reveal plugin folder", systemImage: "folder") }
                Button {
                    Task { await reloadPlugins() }
                } label: { Label("Reload from disk", systemImage: "arrow.clockwise") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.categoryTeal.opacity(0.6))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Install or reload plugins")
        }
        .sheet(isPresented: $showingGitInstallSheet) {
            PluginGitInstallSheet { url, ref in
                showingGitInstallSheet = false
                Task { await installFromGit(url: url, ref: ref) }
            } onCancel: {
                showingGitInstallSheet = false
            }
        }
        .sheet(isPresented: $showingClaudeImportSheet) {
            ClaudePluginImportSheet(api: api,
                onDismiss: { showingClaudeImportSheet = false },
                onImported: { Task { await refreshPlugins() } })
        }
        .alert("Plugin install", isPresented: Binding(
            get: { pluginInstallMessage != nil },
            set: { if !$0 { pluginInstallMessage = nil } }
        )) {
            Button("OK") { pluginInstallMessage = nil }
        } message: {
            Text(pluginInstallMessage ?? "")
        }
        .alert("Plugin already installed", isPresented: Binding(
            get: { pendingReplaceInstall != nil },
            set: { if !$0 { pendingReplaceInstall = nil } }
        )) {
            Button("Replace", role: .destructive) { Task { await replaceInstall() } }
            Button("Cancel", role: .cancel) { pendingReplaceInstall = nil }
        } message: {
            Text("A plugin with this name is already installed. Replace it with this version?")
        }
    }

    /// Load installed plugins for the Library → Plugins section.
    /// Errors are swallowed — the section stays empty on failure.
    private func loadPlugins() async {
        let pluginsResp = try? await api.listPlugins()
        self.plugins = pluginsResp?.plugins ?? []
    }

    private func refreshPlugins() async {
        let resp = try? await api.listPlugins()
        self.plugins = resp?.plugins ?? []
    }

    private func reloadPlugins() async {
        _ = try? await api.reloadPlugins()
        await refreshPlugins()
    }

    private func revealPluginsFolder() {
        Task {
            if let resp = try? await api.listPlugins() {
                let url = URL(fileURLWithPath: resp.pluginDir, isDirectory: true)
                NSWorkspace.shared.activateFileViewerSelecting([url])
            }
        }
    }

    private func installFromZip() async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a plugin .zip"
        panel.prompt = "Install"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        await performInstall { replace in try await api.installPlugin(zipURL: url, replace: replace) }
    }

    private func installFromGit(url: String, ref: String?) async {
        await performInstall { replace in
            try await api.installPluginFromGit(url: url, ref: ref, replace: replace)
        }
    }

    /// Common install plumbing: run the install closure, surface
    /// success/failure via the alert, and refresh the sidebar list. On 409
    /// (already installed) it holds the op so the "Plugin already installed"
    /// alert can re-run it with replace=true — the in-Library replacement for
    /// the old "overwrite from Settings → Plugins" flow.
    private func performInstall(_ op: @escaping (_ replace: Bool) async throws -> PluginInstallResponse) async {
        do {
            let resp = try await op(false)
            pluginInstallMessage = "Installed \(resp.plugin.displayName.isEmpty ? resp.plugin.name : resp.plugin.displayName) v\(resp.plugin.version)."
            await refreshPlugins()
        } catch let APIError.http(_, code, message, _) where code == "HTTP_ERROR" && message.contains("already installed") {
            pendingReplaceInstall = op
        } catch {
            pluginInstallMessage = error.localizedDescription
        }
    }

    /// Re-run the held install with replace=true after the user confirms.
    private func replaceInstall() async {
        guard let op = pendingReplaceInstall else { return }
        pendingReplaceInstall = nil
        do {
            let resp = try await op(true)
            pluginInstallMessage = "Replaced \(resp.plugin.displayName.isEmpty ? resp.plugin.name : resp.plugin.displayName) — now v\(resp.plugin.version)."
            await refreshPlugins()
        } catch {
            pluginInstallMessage = error.localizedDescription
        }
    }

    private func uninstall(_ plugin: PluginInfo) async {
        do {
            _ = try await api.uninstallPlugin(name: plugin.name)
            await refreshPlugins()
        } catch {
            pluginInstallMessage = error.localizedDescription
        }
    }

    // MARK: - LLM Sources section

    @ViewBuilder
    private var llmSourcesSection: some View {
        Section {
            if sectionExpanded("llmSources").wrappedValue {
                if llmSources.isEmpty {
                    emptyRow("No LLM sources registered yet.", icon: "books.vertical")
                } else {
                    ForEach(llmSources) { s in
                        LlmSourceRow(source: s) { enabled in
                            Task { await toggleSource(s.id, enabled: enabled) }
                        }
                        .tag(ShellState.LibrarySelection.llmSource(s.id))
                        .contextMenu {
                            if !s.builtin {
                                Button(role: .destructive) {
                                    Task { await removeSource(s.id) }
                                } label: { Label("Remove", systemImage: "trash") }
                            }
                        }
                    }
                }
            }
        } header: {
            llmSourcesHeader
        }
    }

    /// Section header row with the "+" add menu.
    @ViewBuilder
    private var llmSourcesHeader: some View {
        unifiedSectionHeader(
            id: "llmSources", title: "LLM Sources", icon: "books.vertical",
            tint: theme.current.categoryAmber, count: llmSources.count
        ) {
            Menu {
                Button {
                    showingLlmSourceAddSheet = true
                } label: { Label("Add LLM source…", systemImage: "plus.circle") }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.categoryAmber.opacity(0.6))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Add an LLM source")
        }
        .sheet(isPresented: $showingLlmSourceAddSheet) {
            LlmSourceAddSheet(onSubmit: { url, path, ref, name in
                showingLlmSourceAddSheet = false
                Task { await addSource(url: url, path: path, ref: ref, name: name) }
            }, onCancel: {
                showingLlmSourceAddSheet = false
            })
        }
        .alert("LLM source", isPresented: Binding(
            get: { llmSourceMessage != nil },
            set: { if !$0 { llmSourceMessage = nil } }
        )) {
            Button("OK") { llmSourceMessage = nil }
        } message: {
            Text(llmSourceMessage ?? "")
        }
    }

    /// Load registered LLM sources for the Library section. Errors are
    /// swallowed — the section stays empty on failure, matching `loadPlugins`.
    private func loadLlmSources() async {
        llmSources = (try? await api.listLlmSources()) ?? []
    }

    private func refreshLlmSources() async {
        llmSources = (try? await api.listLlmSources()) ?? []
    }

    private func toggleSource(_ id: String, enabled: Bool) async {
        do {
            _ = try await api.toggleLlmSource(id: id, enabled: enabled)
            await refreshLlmSources()
        } catch {
            llmSourceMessage = error.localizedDescription
        }
    }

    private func addSource(url: String?, path: String?, ref: String?, name: String?) async {
        do {
            let added = try await api.addLlmSource(url: url, path: path, ref: ref, name: name)
            llmSourceMessage = "Added \(added.name)."
            await refreshLlmSources()
        } catch {
            llmSourceMessage = error.localizedDescription
        }
    }

    private func removeSource(_ id: String) async {
        do {
            try await api.removeLlmSource(id: id)
            if case .llmSource(let sel) = shell.librarySelection, sel == id {
                shell.librarySelection = nil
            }
            await refreshLlmSources()
        } catch {
            llmSourceMessage = error.localizedDescription
        }
    }

    // MARK: - MCP Plugins

    @ViewBuilder
    private var mcpPluginsSection: some View {
        Section {
            if sectionExpanded("mcpPlugins").wrappedValue {
                if let mcpPluginsError {
                    HStack(spacing: 6) {
                        Text(mcpPluginsError).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Button("Retry") { Task { await loadMcpPlugins() } }
                            .font(.caption)
                    }
                    .padding(.vertical, 2)
                } else if mcpPlugins.isEmpty {
                    emptyRow("No MCP plugins registered yet.", icon: "bolt.horizontal.circle")
                } else {
                    ForEach(mcpPlugins) { p in
                        McpPluginRow(
                            plugin: p,
                            onToggleConsent: { consented in Task { await consentPlugin(p.id, consented: consented) } },
                            onToggleEnabled: { enabled in Task { await togglePlugin(p.id, enabled: enabled) } }
                        )
                        .tag(ShellState.LibrarySelection.mcpPlugin(p.id))
                        .contextMenu {
                            Button(role: .destructive) {
                                Task { await removePlugin(p.id) }
                            } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                }
            }
        } header: {
            mcpPluginsHeader
        }
    }

    /// Section header row with the "Add from Claude Code…" menu.
    @ViewBuilder
    private var mcpPluginsHeader: some View {
        unifiedSectionHeader(
            id: "mcpPlugins", title: "MCP Plugins", icon: "bolt.horizontal.circle",
            tint: theme.current.categoryPurple, count: mcpPlugins.count
        ) {
            Menu {
                Menu("Add from Claude Code…") {
                    if mcpClaudeSources.isEmpty {
                        Button("No servers found in ~/.claude.json") {}.disabled(true)
                    } else {
                        ForEach(mcpClaudeSources) { s in
                            Button(s.name) {
                                Task { await addPluginFromClaude(s.name) }
                            }
                        }
                    }
                    Divider()
                    Button("Rescan") { Task { await scanClaudeSources() } }
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.current.categoryPurple.opacity(0.6))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Add an MCP plugin")
            .task { await scanClaudeSources() }
        }
        .alert("MCP plugin", isPresented: Binding(
            get: { mcpPluginMessage != nil },
            set: { if !$0 { mcpPluginMessage = nil } }
        )) {
            Button("OK") { mcpPluginMessage = nil }
        } message: {
            Text(mcpPluginMessage ?? "")
        }
    }

    private func loadMcpPlugins() async {
        do {
            mcpPlugins = try await api.listMcpPlugins()
            mcpPluginsError = nil
        } catch {
            mcpPluginsError = error.localizedDescription
        }
    }

    private func refreshMcpPlugins() async { await loadMcpPlugins() }

    /// Admin-only scan; a non-admin caller's 403 is swallowed here — the
    /// submenu just stays empty, matching the read-only nature of the scan
    /// (nothing actionable for a non-admin to retry).
    private func scanClaudeSources() async {
        mcpClaudeSources = (try? await api.scanClaudeMcpSources()) ?? []
    }

    private func addPluginFromClaude(_ claudeName: String) async {
        do {
            let added = try await api.addMcpPlugin(claudeName: claudeName)
            mcpPluginMessage = "Added \(added.name)."
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    private func consentPlugin(_ id: String, consented: Bool) async {
        do {
            _ = try await api.consentMcpPlugin(id: id, consented: consented)
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    private func togglePlugin(_ id: String, enabled: Bool) async {
        do {
            _ = try await api.toggleMcpPlugin(id: id, enabled: enabled)
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
        }
    }

    private func removePlugin(_ id: String) async {
        do {
            try await api.removeMcpPlugin(id: id)
            if case .mcpPlugin(let sel) = shell.librarySelection, sel == id {
                shell.librarySelection = nil
            }
            await refreshMcpPlugins()
        } catch {
            mcpPluginMessage = error.localizedDescription
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
        // Remove ONLY from the SQLite index — the .md file stays on disk
        // and remains visible in the MEETINGS transcript section.
        // To delete the physical file, use "Delete Transcript" in the
        // MEETINGS file tree section.
        try? env.index.delete(id: id)
        // Clear the detail selection if this meeting was open.
        if case .meeting(let sel) = shell.librarySelection, sel == id {
            shell.librarySelection = nil
        }
        // Refresh the list.
        try? vm?.refresh()
    }
}
