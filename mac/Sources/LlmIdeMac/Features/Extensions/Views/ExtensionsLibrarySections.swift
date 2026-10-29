import SwiftUI

/// The Library sidebar's **Plugins** section. Moved out of `LibraryView`; the
/// rows, menus, sheets and alerts are unchanged.
///
/// User-scoped — shown regardless of active project. Install / import / reload
/// live in this section's header menu (the ⊕); uninstall in each row's context
/// menu. Agents / Skills browse UIs were removed; skills install into the
/// project via the central kit, and the Code Assistant "/" menu still
/// discovers them.
struct PluginsLibrarySection: View {
    @Bindable var model: ExtensionsLibraryModel
    let isExpanded: Binding<Bool>
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        Section {
            if isExpanded.wrappedValue {
                if let pluginsError = model.pluginsError {
                    HStack(spacing: 6) {
                        Text("Couldn't read the plugin list: \(pluginsError)")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Button("Retry") { Task { await model.loadPlugins() } }.font(.caption)
                    }
                    .padding(.vertical, 2)
                }
                if model.plugins.isEmpty {
                    // Only claim "none" when the list was actually read.
                    if model.pluginsError == nil {
                        LibraryEmptyRow(text: "No plugins installed yet — install from .zip or a Git URL.",
                                        icon: "puzzlepiece.extension")
                    }
                } else {
                    ForEach(model.plugins) { p in
                        PluginLibraryRow(plugin: p,
                                         updateTier: model.pluginUpdates.first { $0.name == p.name }?.tier)
                            .tag(LibrarySelection.plugin(p.name))
                            .contextMenu {
                                Button(role: .destructive) {
                                    model.pendingRemoval = .plugin(name: p.name, title: p.title)
                                } label: { Label("Uninstall", systemImage: "trash") }
                            }
                    }
                }
            }
        } header: {
            header
        }
    }

    /// Section header row with the "+" install menu.
    @ViewBuilder
    private var header: some View {
        LibrarySectionHeader(
            title: "Plugins", icon: "puzzlepiece.extension",
            tint: theme.current.categoryTeal, count: model.plugins.count,
            isExpanded: isExpanded
        ) {
            // Right: install menu — same frame/font as the + buttons above.
            Menu {
                Button {
                    Task { await model.installFromZip() }
                } label: { Label("Install from .zip…", systemImage: "doc.zipper") }
                Button {
                    model.showingGitInstallSheet = true
                } label: { Label("Install from Git URL…", systemImage: "link") }
                Button {
                    model.showingMarketplaceSheet = true
                } label: { Label("Add marketplace…", systemImage: "bag") }
                Button {
                    model.showingClaudeImportSheet = true
                } label: { Label("Import from Claude Code…", systemImage: "arrow.down.circle") }
                Button {
                    model.showingCodexImportSheet = true
                } label: { Label("Import from Codex…", systemImage: "arrow.down.circle") }
                if !model.pluginUpdates.isEmpty {
                    Divider()
                    Section("Updates available") {
                        ForEach(model.pluginUpdates) { update in
                            Button {
                                model.applyPluginUpdate(update)
                            } label: {
                                Label(update.name + (update.targetVersion.map { " → \($0)" } ?? ""),
                                      systemImage: "arrow.triangle.2.circlepath")
                            }
                            .disabled(model.updateCenter.isUpdating)
                        }
                        Button {
                            model.applyAllPluginUpdates()
                        } label: { Label("Update all (\(model.pluginUpdates.count))", systemImage: "square.and.arrow.down.on.square") }
                        .disabled(model.updateCenter.isUpdating)
                    }
                }
                Divider()
                Button {
                    model.revealPluginsFolder()
                } label: { Label("Reveal plugin folder", systemImage: "folder") }
                Button {
                    Task { await model.rescanVendorSources() }
                } label: { Label("Check for plugin updates", systemImage: "arrow.clockwise.circle") }
                // A forced check runs `claude plugin marketplace update`; not while an update runs.
                .disabled(model.updateCenter.isUpdating)
                Button {
                    Task { await model.reloadPlugins() }
                } label: { Label("Reload from disk", systemImage: "arrow.clockwise") }
            } label: {
                Image(systemName: model.pluginUpdates.isEmpty ? "plus" : "arrow.triangle.2.circlepath")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(model.pluginUpdates.isEmpty
                                     ? theme.current.categoryTeal.opacity(0.6)
                                     : theme.current.categoryTeal)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 20)
            .help(model.pluginUpdates.isEmpty
                  ? "Install or reload plugins"
                  : "\(model.pluginUpdates.count) plugin update\(model.pluginUpdates.count == 1 ? "" : "s") available")
        }
        .sheet(isPresented: $model.showingGitInstallSheet) {
            PluginGitInstallSheet { url, ref in
                model.showingGitInstallSheet = false
                Task { await model.installFromGit(url: url, ref: ref) }
            } onCancel: {
                model.showingGitInstallSheet = false
            }
        }
        .sheet(isPresented: $model.showingMarketplaceSheet) {
            PluginMarketplaceSheet(api: model.api,
                onDismiss: { model.showingMarketplaceSheet = false },
                onInstalled: { Task { await model.refreshPlugins() } })
        }
        .sheet(isPresented: $model.showingClaudeImportSheet) {
            ClaudePluginImportSheet(api: model.api,
                onDismiss: { model.showingClaudeImportSheet = false },
                onImported: { Task { await model.refreshPlugins() } })
        }
        .sheet(isPresented: $model.showingCodexImportSheet) {
            CodexPluginImportSheet(api: model.api,
                onDismiss: { model.showingCodexImportSheet = false },
                onImported: { Task { await model.refreshPlugins() } })
        }
        .sheet(item: Binding(
            get: { model.updateCenter.pendingOrigin == .library ? model.updateCenter.pendingConfirmation : nil },
            set: { model.updateCenter.pendingConfirmation = $0 }
        ), onDismiss: { model.updateCenter.confirmationDismissed() }) { confirmation in
            PluginUpdateConfirmSheet(confirmation: confirmation) {
                model.updateCenter.accept(confirmation, api: model.api, oneClick: model.usesOneClickUpdate)
            } onCancel: {
                model.updateCenter.pendingConfirmation = nil
            }
        }
        .alert("Plugin install", isPresented: Binding(
            get: { model.pluginInstallMessage != nil },
            set: { if !$0 { model.pluginInstallMessage = nil } }
        )) {
            Button("OK") { model.pluginInstallMessage = nil }
        } message: {
            Text(model.pluginInstallMessage ?? "")
        }
        .alert("Plugin already installed", isPresented: Binding(
            get: { model.pendingReplaceInstall != nil },
            set: { if !$0 { model.pendingReplaceInstall = nil } }
        )) {
            Button("Replace", role: .destructive) {
                // Captured now: the alert's dismissal clears the binding before
                // the Task body runs, which used to make Replace a silent no-op.
                let op = model.pendingReplaceInstall
                model.pendingReplaceInstall = nil
                Task { await model.replaceInstall(op) }
            }
            Button("Cancel", role: .cancel) { model.pendingReplaceInstall = nil }
        } message: {
            Text("A plugin with this name is already installed. Replace it with this version?")
        }
        .confirmationDialog(
            model.pendingRemoval?.dialogTitle ?? "",
            isPresented: model.removalBinding { if case .plugin = $0 { return true } else { return false } },
            titleVisibility: .visible,
            presenting: model.pendingRemoval
        ) { removal in
            model.removalButtons(removal)
        } message: { removal in
            Text(removal.message)
        }
    }
}

/// The Library sidebar's **LLM Sources** section: registered LLM-resource repos
/// (builtin .skills + user-added git/local sources), each contributing any mix
/// of skills (chat "/" menu discovery via /kb/agent/skill-library), agents, and
/// hooks. Agents/hooks are catalogued for display only — never invoked/executed.
struct LlmSourcesLibrarySection: View {
    @Bindable var model: ExtensionsLibraryModel
    let isExpanded: Binding<Bool>
    @EnvironmentObject private var theme: ThemeStore

    /// Inline error row for the LLM Sources section — shown when the fetch
    /// fails, with a Retry. Mirrors `LibraryEmptyRow`'s framing so it lines up
    /// with the "no sources" placeholder it replaces.
    @ViewBuilder
    private func errorRow(_ msg: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
            Text(msg)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button("Retry") { Task { await model.loadLlmSources() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
        .listRowSeparator(.hidden)
    }

    var body: some View {
        Section {
            if isExpanded.wrappedValue {
                if let err = model.llmSourcesError {
                    errorRow(err)
                } else if model.llmSources.isEmpty {
                    LibraryEmptyRow(text: "No LLM sources registered yet.", icon: "books.vertical")
                } else {
                    ForEach(model.llmSources) { s in
                        LlmSourceRow(source: s, updateAvailable: model.llmSourceUpdates[s.id]?.updateAvailable == true) { enabled in
                            Task { await model.toggleSource(s.id, enabled: enabled) }
                        }
                        .tag(LibrarySelection.llmSource(s.id))
                        .contextMenu {
                            if !s.builtin {
                                Button(role: .destructive) {
                                    model.pendingRemoval = .llmSource(id: s.id, name: s.name)
                                } label: { Label("Remove", systemImage: "trash") }
                            }
                        }
                    }
                }
            }
        } header: {
            header
        }
    }

    /// Section header row with the "+" add menu.
    @ViewBuilder
    private var header: some View {
        LibrarySectionHeader(
            title: "LLM Sources", icon: "books.vertical",
            tint: theme.current.categoryAmber, count: model.llmSources.count,
            isExpanded: isExpanded
        ) {
            Menu {
                Button {
                    model.showingLlmSourceAddSheet = true
                } label: { Label("Add LLM source…", systemImage: "plus.circle") }
                Button {
                    Task { await model.loadLlmSourceUpdates(force: true) }
                } label: { Label("Check for updates", systemImage: "arrow.triangle.2.circlepath") }
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
        .sheet(isPresented: $model.showingLlmSourceAddSheet) {
            LlmSourceAddSheet(onSubmit: { url, path, ref, name in
                model.showingLlmSourceAddSheet = false
                Task { await model.addSource(url: url, path: path, ref: ref, name: name) }
            }, onCancel: {
                model.showingLlmSourceAddSheet = false
            })
        }
        .alert("LLM source", isPresented: Binding(
            get: { model.llmSourceMessage != nil },
            set: { if !$0 { model.llmSourceMessage = nil } }
        )) {
            Button("OK") { model.llmSourceMessage = nil }
        } message: {
            Text(model.llmSourceMessage ?? "")
        }
        .confirmationDialog(
            model.pendingRemoval?.dialogTitle ?? "",
            isPresented: model.removalBinding { if case .llmSource = $0 { return true } else { return false } },
            titleVisibility: .visible,
            presenting: model.pendingRemoval
        ) { removal in
            model.removalButtons(removal)
        } message: { removal in
            Text(removal.message)
        }
    }
}

/// The Library sidebar's **MCP Plugins** section: servers imported from
/// ~/.claude.json or registered manually, gated by per-user consent + enable
/// before they reach the Claude CLI's --mcp-config.
struct McpPluginsLibrarySection: View {
    @Bindable var model: ExtensionsLibraryModel
    let isExpanded: Binding<Bool>
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        Section {
            if isExpanded.wrappedValue {
                if let mcpPluginsError = model.mcpPluginsError {
                    HStack(spacing: 6) {
                        Text(mcpPluginsError).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Button("Retry") { Task { await model.loadMcpPlugins() } }
                            .font(.caption)
                    }
                    .padding(.vertical, 2)
                } else if model.mcpPlugins.isEmpty {
                    LibraryEmptyRow(text: "No MCP plugins registered yet.", icon: "bolt.horizontal.circle")
                } else {
                    // Say what the enabled ones cost before the list, so the price of
                    // leaving a server on is visible where it is switched.
                    Text(McpUsageNotes.sectionSummary(
                        enabledCount: model.mcpPlugins.filter(\.isEffective).count))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 2)
                    ForEach(model.mcpPlugins) { p in
                        McpPluginRow(
                            plugin: p,
                            versionUpdate: model.mcpUpdateCenter.update(for: p.id),
                            onToggleConsent: { consented in
                                // Granting runs a process (or reaches a URL) with
                                // this user's session: confirm with the full
                                // command first. Revoking only removes power.
                                if consented {
                                    model.pendingMcpConsent = McpConsentPrompt(plugin: p)
                                } else {
                                    Task { await model.consentPlugin(p.id, consented: false) }
                                }
                            },
                            onToggleEnabled: { enabled in Task { await model.togglePlugin(p.id, enabled: enabled) } }
                        )
                        .tag(LibrarySelection.mcpPlugin(p.id))
                        .contextMenu {
                            Button(role: .destructive) {
                                model.pendingRemoval = .mcpServer(id: p.id, name: p.name)
                            } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                }
            }
        } header: {
            header
        }
    }

    /// Section header row with the "Add from Claude Code…" menu.
    @ViewBuilder
    private var header: some View {
        LibrarySectionHeader(
            title: "MCP Plugins", icon: "bolt.horizontal.circle",
            tint: theme.current.categoryPurple, count: model.mcpPlugins.count,
            isExpanded: isExpanded
        ) {
            Menu {
                Menu("Add from catalog…") {
                    if model.mcpCatalog.isEmpty {
                        Button("Catalog unavailable") {}.disabled(true)
                    } else {
                        ForEach(model.mcpCatalog) { entry in
                            Button {
                                // An entry that needs a directory or DSN opens
                                // the sheet; everything else adds in one click.
                                if entry.requiresArg != nil {
                                    model.mcpAddSheet = .catalogArg(entry)
                                } else {
                                    Task { await model.addMcpPlugin(catalogId: entry.id, arg: nil, name: nil,
                                                                    transport: nil, command: nil, args: nil, url: nil) }
                                }
                            } label: {
                                Label(entry.registered ? "\(entry.name) (added)" : entry.name,
                                      systemImage: entry.isHosted ? "cloud" : "terminal")
                            }
                            .disabled(entry.registered)
                        }
                    }
                }
                Divider()
                Menu("Add from Claude Code…") {
                    if model.mcpClaudeSources.isEmpty {
                        Button("No servers found in ~/.claude.json") {}.disabled(true)
                    } else {
                        ForEach(model.mcpClaudeSources) { s in
                            Button(s.name) {
                                Task { await model.addPluginFromClaude(s.name) }
                            }
                        }
                    }
                    Divider()
                    Button("Rescan") { Task { await model.scanClaudeSources() } }
                }
                Menu("Add from Codex…") {
                    if model.mcpCodexSources.isEmpty {
                        Button("No servers found in ~/.codex/config.toml") {}.disabled(true)
                    } else {
                        ForEach(model.mcpCodexSources) { s in
                            Button(s.name) {
                                Task { await model.addPluginFromCodex(s.name) }
                            }
                        }
                    }
                    Divider()
                    Button("Rescan") { Task { await model.scanCodexSources() } }
                }
                Divider()
                Button("Add manually…") { model.mcpAddSheet = .manual }
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
        }
        .alert("MCP plugin", isPresented: Binding(
            get: { model.mcpPluginMessage != nil },
            set: { if !$0 { model.mcpPluginMessage = nil } }
        )) {
            Button("OK") { model.mcpPluginMessage = nil }
        } message: {
            Text(model.mcpPluginMessage ?? "")
        }
        .sheet(item: $model.mcpAddSheet) { mode in
            McpAddSheet(mode: mode) { catalogId, arg, name, transport, command, args, url in
                Task {
                    await model.addMcpPlugin(catalogId: catalogId, arg: arg, name: name,
                                             transport: transport, command: command, args: args, url: url)
                }
            }
            .environmentObject(theme)
        }
        .confirmationDialog(
            model.pendingMcpConsent?.dialogTitle ?? "",
            isPresented: Binding(get: { model.pendingMcpConsent != nil }, set: { if !$0 { model.pendingMcpConsent = nil } }),
            titleVisibility: .visible,
            presenting: model.pendingMcpConsent
        ) { prompt in
            Button(prompt.confirmLabel) {
                model.pendingMcpConsent = nil
                Task { await model.consentPlugin(prompt.pluginId, consented: true) }
            }
            Button("Cancel", role: .cancel) { model.pendingMcpConsent = nil }
        } message: { prompt in
            Text(prompt.message)
        }
        .confirmationDialog(
            model.pendingRemoval?.dialogTitle ?? "",
            isPresented: model.removalBinding { if case .mcpServer = $0 { return true } else { return false } },
            titleVisibility: .visible,
            presenting: model.pendingRemoval
        ) { removal in
            model.removalButtons(removal)
        } message: { removal in
            Text(removal.message)
        }
    }
}

/// The non-visual half of the Extensions sidebar sections: what `LibraryView`
/// used to do in its own `.task` / `.onChange` modifiers for plugins, LLM
/// sources and MCP servers. Mounted once by Library as a `.background`.
struct ExtensionsLibraryLifecycle: View {
    @Bindable var model: ExtensionsLibraryModel
    private var updateCenter: PluginUpdateCenter { .shared }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .task {
                await model.loadLlmSources()
                await model.loadLlmSourceUpdates(force: false)
            }
            .task { await model.loadMcpPlugins() }
            .task {
                // Plugins first: the update check routes (and checks git /
                // marketplace origins) by each plugin's install source.
                await model.loadPlugins()
                await model.loadPluginUpdates()
                model.consumeUpdateMessage()
            }
            .task { await model.scanClaudeSources() }
            .task { await model.scanCodexSources() }
            // An update finishing elsewhere (or while this view was gone) must
            // reach the rows and the alert.
            // The token bump reloads the plugin rows (and the detail pane) here.
            .onChange(of: updateCenter.changeToken) { model.shell.markLibraryDirty() }
            .onChange(of: updateCenter.libraryMessage) { model.consumeUpdateMessage() }
            // The version gate decides which update API to ask; the first probe of
            // the server can land after this view appeared.
            .onChange(of: model.backend.serverApiVersion) { Task { await model.loadPluginUpdates() } }
            // A detail pane can change what these rows should show (MCP consent /
            // enable / remove). It has no way to call back into this list, so it
            // bumps ShellState's token and the affected sections reload here.
            .onChange(of: model.shell.libraryDirtyToken) {
                Task {
                    await model.loadMcpPlugins()
                    // Plugins AND their update state. No invalidation here: an
                    // update already re-checked in the center, and a toggle does
                    // not change what is updatable, so the 60 s TTL applies.
                    await model.loadPlugins()
                    await model.loadPluginUpdates()
                    await model.refreshLlmSources()
                    await model.loadLlmSourceUpdates(force: false)
                }
            }
    }
}

/// Shell's installer for the Extensions half of the Library sidebar and detail
/// pane (`ExtensionsLibraryRegistry`).
enum ExtensionsSeams {
    @MainActor
    static func install(into registry: ExtensionsLibraryRegistry = .shared) {
        registry.install(
            host: { request in
                ExtensionsLibraryModel(api: request.api, shell: request.shell, backend: request.backend)
            },
            section: { request in
                guard let model = request.host as? ExtensionsLibraryModel else { return AnyView(EmptyView()) }
                switch request.kind {
                case .plugins:
                    return AnyView(PluginsLibrarySection(model: model, isExpanded: request.isExpanded))
                case .llmSources:
                    return AnyView(LlmSourcesLibrarySection(model: model, isExpanded: request.isExpanded))
                case .mcpPlugins:
                    return AnyView(McpPluginsLibrarySection(model: model, isExpanded: request.isExpanded))
                }
            },
            lifecycle: { host in
                guard let model = host as? ExtensionsLibraryModel else { return AnyView(EmptyView()) }
                return AnyView(ExtensionsLibraryLifecycle(model: model))
            },
            detail: { selection, api in
                switch selection {
                case .plugin(let name):
                    // `.id` for the same reason as the LLM source below, and with more at
                    // stake: a refresh still in flight for plugin A would otherwise land in
                    // B's pane, and a Trust click there would act on B with A's kinds.
                    return AnyView(PluginDetailView(api: api, pluginName: name).id(name))
                case .llmSource(let id):
                    // `.id` gives each source its own view state: without it SwiftUI
                    // reuses one instance across sources, and an Update still running
                    // for source A would land its results in B's pane.
                    return AnyView(LlmSourceDetailView(api: api, sourceId: id).id(id))
                case .mcpPlugin(let id):
                    return AnyView(McpPluginDetailView(api: api, pluginId: id).id(id))
                case .meeting, .file, .connector:
                    return nil
                }
            })
    }
}
