import SwiftUI

struct LibraryView: View {
    let api: MeetNotesAPIClient
    @Environment(ShellState.self) private var shell
    @Environment(AppEnvironment.self) private var env
    @Environment(LibraryItemStore.self) private var itemStore
    @Environment(AgentCatalogStore.self) private var catalogStore
    @State private var vm: LibraryViewModel?
    @State private var loadError: String?
    @FocusState private var filterFocused: Bool
    /// Tracks which folder groups are expanded per category
    @State private var expandedFolders: Set<String> = []
    /// Installed plugins for the current user. Loaded once on appear
    /// and refreshed when the user (re-)opens Library. Failures are
    /// silent — the sidebar just shows an empty Plugins section.
    @State private var plugins: [PluginInfo] = []
    /// All of the user's personas, surfaced as Library rows. Cached
    /// on first load + refreshed on .agentPersonaChanged.
    @State private var agentPersonas: [MeetNotesAPIClient.AgentPersonaRow] = []
    @State private var activePersonaId: String?
    @State private var showingGitInstallSheet = false
    @State private var showingClaudeImportSheet = false
    @State private var pluginInstallMessage: String?
    /// Agents section collapses by default.
    @State private var agentsExpanded = false
    /// Skills section collapses by default — it's a reference panel,
    /// not something users browse on every session.
    @State private var skillsExpanded = false
    /// Plugins section collapses by default like Agents and Skills.
    @State private var pluginsExpanded = false

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
        .frame(minWidth: 260, idealWidth: 300)
        .task { await load() }
        .task { await loadAgentsAndPlugins() }
        .onReceive(NotificationCenter.default.publisher(for: .agentPersonaChanged)) { _ in
            Task { await loadAgentsAndPlugins() }
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
    }

    // MARK: - Content

    @ViewBuilder
    private func content(vm: LibraryViewModel) -> some View {
        VStack(spacing: 0) {
            searchBar(filter: Bindable(vm).filter)
            mainList(vm: vm)
        }
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

            // ── Agents section ────────────────────────────────────────
            // Three groups: built-in core agents (locked), user
            // personas (editable, + button to add), plugin subagents
            // (locked, from installed plugins).
            agentsSection

            // ── Skills section ────────────────────────────────────────
            // Three groups: global tools, core KB skills, plugin skills.
            // All read-only / locked — editing requires changing the
            // skill file on disk or managing via the Plugin install flow.
            skillsSection

            // ── Plugins section ───────────────────────────────────────
            // User-scoped — shown regardless of active project. Empty
            // state is suppressed (no installed plugins → no header
            // clutter; user discovers install via Settings → Plugins).
            pluginsSection
        }
        .listStyle(.inset)
        .animation(.easeInOut(duration: 0.2), value: vm.groupedRows.map(\.group))
    }

    // MARK: - File tree section

    @ViewBuilder
    private func fileTreeSection(_ category: LibraryItem.Category) -> some View {
        let sectionItems = itemStore.items(for: category)
        Section {
            let looseFiles = sectionItems.filter { $0.folderOrigin == nil }
            let folderGroups = Dictionary(
                grouping: sectionItems.filter { $0.folderOrigin != nil },
                by: { $0.folderOrigin! }
            )
            let sortedFolders = folderGroups.keys.sorted()

            if sectionItems.isEmpty {
                Text("No \(category.rawValue.lowercased()) files yet")
                    .font(Typography.fileMeta)
                    .foregroundStyle(.tertiary)
                    .listRowSeparator(.hidden)
                    .padding(.vertical, 2)
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
                                .foregroundStyle(category.folderTint)
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

        } header: {
            sectionHeader(category, count: sectionItems.count)
        }
    }

    private func sectionHeader(_ category: LibraryItem.Category, count: Int) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: category.icon)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(category.uiColor)
                    .frame(width: 18, height: 18)
                    .background(category.uiColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                Text(category.rawValue)
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(category.uiColor)
                    .textCase(.uppercase)
                    .tracking(0.5)
                if count > 0 {
                    Text("\(count)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(category.uiColor.opacity(0.6))
                }
            }
            Spacer(minLength: 4)
            Menu {
                Button { pickFile(for: category) } label: {
                    Label("Add File", systemImage: "doc.badge.plus")
                }
                Button { pickFolder(for: category) } label: {
                    Label("Add Folder", systemImage: "folder.badge.plus")
                }
                if category == .meetings {
                    Divider()
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
                    .foregroundStyle(category.uiColor.opacity(0.5))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help(category == .meetings ? "Add transcript or reveal folder" : "Add file or folder")
        }
        // Breathing room above each section groups it visually (Finder-style)
        // and stops the colored uppercase label from crowding the folder/file
        // rows beneath it. Smaller bottom inset keeps the label tied to its
        // own content rather than floating between sections.
        .padding(.top, 12)
        .padding(.bottom, 3)
    }

    private func pickFile(for category: LibraryItem.Category) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.message = "Choose files to add to \(category.rawValue)"
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { itemStore.add(url: url, category: category) }
    }

    private func pickFolder(for category: LibraryItem.Category) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder — all files inside will be added to \(category.rawValue)"
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

    // MARK: - Agents section

    @ViewBuilder
    private var agentsSection: some View {
        let allPluginSubagents = catalogStore.catalog?.subagents.plugins ?? []

        Section {
            // All content only rendered when expanded — collapsed by default.
            if agentsExpanded {
                // ── Sub-group 1: Built-in core agents (locked) ──────────
                subGroupLabel("Built-in", icon: "shield.checkmark.fill", color: .blue)

                AgentLibraryRow(
                    title: "Meeting Assistant",
                    subtitle: "Live in-session question loop",
                    kind: .builtin
                )
                .tag(ShellState.LibrarySelection.builtinAgent("meeting-assistant"))

                AgentLibraryRow(
                    title: "Ask Agent",
                    subtitle: "Code-assist & knowledge loop",
                    kind: .builtin
                )
                .tag(ShellState.LibrarySelection.builtinAgent("ask-agent"))

                // ── Sub-group 2: User personas (editable) ───────────────
                subGroupLabel("My Personas", icon: "person.crop.circle", color: .purple)

                if agentPersonas.isEmpty {
                    AgentLibraryRow(
                        title: "No personas yet",
                        subtitle: "Tap + to create one",
                        kind: .persona(isActive: false)
                    )
                    .tag(ShellState.LibrarySelection.agent("default"))
                    .foregroundStyle(.secondary)
                } else {
                    ForEach(agentPersonas) { p in
                        let isActive = p.id == activePersonaId
                        AgentLibraryRow(
                            title: p.name?.isEmpty == false ? p.name! : "(unnamed)",
                            subtitle: isActive ? "Active persona" : "Persona",
                            kind: .persona(isActive: isActive)
                        )
                        .tag(ShellState.LibrarySelection.agent(p.id))
                    }
                }

                // ── Sub-group 3: Plugin subagents (locked) ──────────────
                if !allPluginSubagents.isEmpty {
                    subGroupLabel("From Plugins", icon: "puzzlepiece.extension", color: .teal)
                    ForEach(allPluginSubagents, id: \.pluginName) { group in
                        ForEach(group.subagents, id: \.name) { sub in
                            AgentLibraryRow(
                                title: sub.name,
                                subtitle: group.pluginDisplayName,
                                kind: .plugin
                            )
                            .tag(ShellState.LibrarySelection.plugin(group.pluginName))
                        }
                    }
                }
            }
        } header: {
            agentsHeader
        }
    }

    @ViewBuilder
    private var agentsHeader: some View {
        HStack(spacing: 0) {
            // Toggle button: icon + label + spacer + chevron (chevron at far right)
            let agentColor = Color(red: 0.20, green: 0.45, blue: 0.95)
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { agentsExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain.head.profile")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(agentColor)
                        .frame(width: 18, height: 18)
                        .background(agentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                    Text("Agents")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(agentColor)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(agentsExpanded ? 90 : 0))
                        .animation(.easeInOut(duration: 0.18), value: agentsExpanded)
                }
            }
            .buttonStyle(.plain)
            .help(agentsExpanded ? "Collapse Agents" : "Expand Agents")

            // Add-persona button — always visible, separated from the toggle.
            Button {
                Task { await addPersona() }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 4)
            .disabled(agentPersonas.count >= 10)
            .help(agentPersonas.count >= 10 ? "Persona limit reached (10)" : "Add a persona")
        }
        .padding(.top, 12)
        .padding(.bottom, 3)
    }

    private func addPersona() async {
        guard let resp = try? await api.createAgentPersona(name: "New persona", promptSuffix: "", autoDispatch: false) else { return }
        let newest = resp.personas.sorted { $0.createdAt < $1.createdAt }.last
        self.agentPersonas = resp.personas
        self.activePersonaId = resp.active
        if let id = newest?.id {
            shell.librarySelection = .agent(id)
        }
    }

    // MARK: - Shared sub-group label

    /// Unified sub-group label used by both the Agents and Skills sections.
    /// All sub-groups across both sections render identically: small icon,
    /// caption2 semi-bold text, subtle top padding.
    private func subGroupLabel(_ title: String, icon: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.top, 4)
        .listRowSeparator(.hidden)
    }

    // MARK: - Skills section

    @ViewBuilder
    private var skillsSection: some View {
        let globalSkills   = catalogStore.catalog?.skills.global   ?? []
        let internalSkills = catalogStore.catalog?.skills.internal ?? []
        let pluginGroups   = catalogStore.catalog?.skills.plugins  ?? []
        let totalSkills    = globalSkills.count + internalSkills.count
            + pluginGroups.reduce(0) { $0 + $1.skills.count }

        Section {
            // Content only rendered when expanded — collapsed by default.
            if skillsExpanded {
                if totalSkills == 0 {
                    Text("Loading skills…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                } else {
                    // Global tools sub-group label
                    if !globalSkills.isEmpty {
                        subGroupLabel("Global Tools", icon: "globe", color: .blue)
                        ForEach(globalSkills) { skill in
                            SkillLibraryRow(skill: skill, pluginName: nil)
                                .tag(ShellState.LibrarySelection.skill(skill.name))
                        }
                    }
                    // Core KB skills sub-group
                    if !internalSkills.isEmpty {
                        subGroupLabel("Core Skills", icon: "building.columns", color: .indigo)
                        ForEach(internalSkills) { skill in
                            SkillLibraryRow(skill: skill, pluginName: nil)
                                .tag(ShellState.LibrarySelection.skill(skill.name))
                        }
                    }
                    // Plugin skills
                    if !pluginGroups.isEmpty {
                        subGroupLabel("From Plugins", icon: "puzzlepiece.extension", color: .teal)
                        ForEach(pluginGroups, id: \.pluginName) { group in
                            ForEach(group.skills) { skill in
                                SkillLibraryRow(skill: skill, pluginName: group.pluginName)
                                    .tag(ShellState.LibrarySelection.skill(skill.name))
                                    .padding(.leading, 6)
                            }
                        }
                    }
                }
            }
        } header: {
            skillsHeader(count: totalSkills)
        }
    }

    private func skillsHeader(count: Int) -> some View {
        let skillColor = Color(red: 0.22, green: 0.70, blue: 0.45) // green (Code family)
        return Button {
            withAnimation(.easeInOut(duration: 0.18)) { skillsExpanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(skillColor)
                    .frame(width: 18, height: 18)
                    .background(skillColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                Text("Skills")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(skillColor)
                    .textCase(.uppercase)
                    .tracking(0.5)
                if count > 0 {
                    Text("\(count)")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(skillColor.opacity(0.6))
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(skillsExpanded ? 90 : 0))
                    .animation(.easeInOut(duration: 0.18), value: skillsExpanded)
            }
        }
        .buttonStyle(.plain)
        .help(skillsExpanded ? "Collapse Skills" : "Expand Skills")
        .padding(.top, 12)
        .padding(.bottom, 3)
    }

    @ViewBuilder
    private var pluginsSection: some View {
        Section {
            if pluginsExpanded {
                if plugins.isEmpty {
                    Text("No plugins installed yet — install one from .zip or a Git URL.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                        .listRowSeparator(.hidden)
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

    /// Section header row with the "+" install menu. Mirrors the visual
    /// style of the Agents and Skills headers: icon + SectionLabel on the
    /// left, small icon-button on the right — same size and colour token.
    @ViewBuilder
    private var pluginsHeader: some View {
        HStack(spacing: 0) {
            let pluginColor = Color.teal
            // Toggle button: icon + label + chevron (matches Agents/Skills pattern)
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { pluginsExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "puzzlepiece.extension")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(pluginColor)
                        .frame(width: 18, height: 18)
                        .background(pluginColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
                    Text("Plugins")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(pluginColor)
                        .textCase(.uppercase)
                        .tracking(0.5)
                    if !plugins.isEmpty {
                        Text("\(plugins.count)")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(pluginColor.opacity(0.6))
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(pluginsExpanded ? 90 : 0))
                        .animation(.easeInOut(duration: 0.18), value: pluginsExpanded)
                }
            }
            .buttonStyle(.plain)
            .help(pluginsExpanded ? "Collapse Plugins" : "Expand Plugins")

            // Right: install menu — same frame/font as the + buttons above
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
                    .foregroundStyle(.tertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help("Install or reload plugins")
        }
        .padding(.top, 12)
        .padding(.bottom, 3)
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
    }

    /// One-shot load for agents, plugins, and the skill catalog.
    /// Errors are swallowed — each section degrades gracefully:
    /// Agents shows default row, Plugins stays empty, Skills shows
    /// "Loading…" until the catalog arrives (or stays empty on error).
    private func loadAgentsAndPlugins() async {
        async let personasTask = try? api.listAgentPersonas()
        async let pluginsTask  = try? api.listPlugins()
        let personasResp = await personasTask
        let pluginsResp  = await pluginsTask
        self.agentPersonas   = personasResp?.personas ?? []
        self.activePersonaId = personasResp?.active
        self.plugins         = pluginsResp?.plugins ?? []
        // Catalog loads via the shared store so LibraryDetailView can
        // read it without its own network call.
        await catalogStore.load(api: api)
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
        await performInstall { try await api.installPlugin(zipURL: url) }
    }

    private func installFromGit(url: String, ref: String?) async {
        await performInstall {
            try await api.installPluginFromGit(url: url, ref: ref)
        }
    }

    /// Common install plumbing: run the install closure, surface
    /// success/failure via the alert, and refresh the sidebar list.
    /// Uses 409 (already installed) as a prompt to retry with
    /// replace=true since that's the common case for "reinstall
    /// the same plugin from a newer commit".
    private func performInstall(_ op: () async throws -> PluginInstallResponse) async {
        do {
            let resp = try await op()
            pluginInstallMessage = "Installed \(resp.plugin.displayName.isEmpty ? resp.plugin.name : resp.plugin.displayName) v\(resp.plugin.version)."
            await refreshPlugins()
        } catch let APIError.http(_, code, message, _) where code == "HTTP_ERROR" && message.contains("already installed") {
            pluginInstallMessage = "\(message)\n\nReinstall (replace) from Settings → Plugins if you want to overwrite."
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
