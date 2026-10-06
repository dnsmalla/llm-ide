import SwiftUI

/// Summary for an installed plugin — listing its skills, slash commands
/// and subagents, with an inline enable toggle. Install lives in the
/// Library Plugins-section header menu; uninstall in that section's row
/// context menu. (Plugin management is wholly in Library now — there is no
/// Settings → Plugins.)
struct PluginDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    @Environment(ShellState.self) private var shell
    /// Read for `serverApiVersion` only — the update block needs API v60+.
    @Environment(BackendManager.self) private var backend
    let api: LlmIdeAPIClient
    let pluginName: String

    @State private var plugin: PluginInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var togglePending = false
    @State private var trustPending = false
    @State private var trustError: String?
    /// Turning trust ON asks first; turning it off never does.
    @State private var confirmingTrust = false
    /// The kinds the user was SHOWN when the dialog opened. Sent with the grant
    /// instead of re-reading `plugin`, which a refresh may have changed since —
    /// the grant must never be larger than what was on screen.
    @State private var kindsShownForTrust: [String]?
    /// An enable / disable failure, kept apart from `loadError` so it does not
    /// replace the whole pane.
    @State private var actionError: String?
    /// Update state is app-lifetime (see `PluginUpdateCenter`): a result must
    /// still be here after the user leaves the Library and comes back.
    private var updateCenter: PluginUpdateCenter { .shared }
    private var updateEntry: PluginUpdateEntry? { updateCenter.entry(for: pluginName) }
    private var checkingUpdates: Bool { updateCenter.checking }
    private var updatePending: Bool { updateCenter.inFlight.contains(pluginName) }
    private var updateResult: PluginUpdateCenter.Result? { updateCenter.results[pluginName] }
    private var oneClick: Bool {
        PluginUpdatePresentation.supportsOneClickUpdate(serverApiVersion: backend.serverApiVersion)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if let actionError {
                    Text(actionError).foregroundStyle(theme.current.danger).font(.callout)
                }
                if !loaded {
                    ProgressView().controlSize(.small)
                } else if let err = loadError {
                    Text(err).foregroundStyle(theme.current.danger).font(.callout)
                } else if let plugin {
                    updateBlock(plugin)
                    descriptionBlock(plugin)
                    commandsBlock(plugin)
                    subagentsBlock(plugin)
                    hooksBlock(plugin)
                    componentsBlock(plugin)
                } else {
                    Text("Plugin not found — it may have been uninstalled.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: pluginName) {
            await load()
            await loadUpdate(force: false)
        }
        .onChange(of: backend.serverApiVersion) { Task { await loadUpdate(force: false) } }
        .sheet(item: Binding(
            get: {
                guard updateCenter.pendingOrigin == .detail,
                      let pending = updateCenter.pendingConfirmation,
                      pending.pluginName == pluginName else { return nil }
                return pending
            },
            set: { updateCenter.pendingConfirmation = $0 }
        ), onDismiss: { updateCenter.confirmationDismissed() }) { confirmation in
            PluginUpdateConfirmSheet(confirmation: confirmation) {
                updateCenter.accept(confirmation, api: api, oneClick: oneClick)
            } onCancel: {
                updateCenter.pendingConfirmation = nil
            }
        }
        // A change made elsewhere must reach this open pane without blanking it.
        .onChange(of: shell.libraryDirtyToken) { Task { await refresh() } }
        .confirmationDialog(
            plugin.map(PluginTrustConfirmation.title) ?? "Trust this plugin?",
            isPresented: $confirmingTrust, titleVisibility: .visible
        ) {
            Button(PluginTrustConfirmation.confirmLabel, role: .destructive) {
                // No captured kinds (nothing was on screen) means no grant: sending
                // none would make the server skip its "never larger than shown" check.
                guard let shown = kindsShownForTrust else { return }
                Task { await setHookTrust(true, shownKinds: shown) }
            }
            Button("Cancel", role: .cancel) { kindsShownForTrust = nil }
        } message: {
            Text(plugin.map(PluginTrustConfirmation.message) ?? "")
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "puzzlepiece.extension.fill")
                .font(.system(size: 28))
                .foregroundStyle(plugin?.enabled == true ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin?.displayName.nonEmpty ?? plugin?.name ?? pluginName)
                    .font(.title2.bold())
                if let plugin {
                    HStack(spacing: 6) {
                        Text("v\(plugin.version)").font(.caption).foregroundStyle(.secondary)
                        if !plugin.author.isEmpty {
                            Text("·").foregroundStyle(.secondary)
                            Text("by \(plugin.author)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if plugin?.name.hasPrefix("claude-") == true {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(Color(red: 0.85, green: 0.55, blue: 0.25))
                        Text("Imported from Claude Code")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if let plugin {
                Toggle("Enabled", isOn: Binding(
                    get: { plugin.enabled },
                    set: { _ in Task { await toggle() } }
                ))
                .toggleStyle(.switch)
                .disabled(togglePending)
            }
        }
    }

    // MARK: - Update

    /// Imported vendor plugins on a v60+ server. A Claude import can always be
    /// re-fetched; a Codex import only updates when its scan reports one.
    private var showsUpdateBlock: Bool {
        guard PluginUpdatePresentation.supportsOneClickUpdate(serverApiVersion: backend.serverApiVersion)
        else { return false }
        return isClaudeImport || pluginName.hasPrefix("codex-")
    }

    private var isClaudeImport: Bool { pluginName.hasPrefix("claude-") }

    /// The version the user knows the copy as: the import stamp, else the
    /// check's view of Claude's install, else the normalized manifest version
    /// (which reads "0.0.0" for a sha-versioned plugin).
    private func shownVersion(_ plugin: PluginInfo) -> String {
        [plugin.sourceVersion, updateEntry?.importedVersion, updateEntry?.claudeVersion]
            .compactMap { $0 }.first { !$0.isEmpty } ?? plugin.version
    }

    @ViewBuilder
    private func updateBlock(_ plugin: PluginInfo) -> some View {
        if showsUpdateBlock {
            VStack(alignment: .leading, spacing: 6) {
                Text("Updates").font(.headline)
                if checkingUpdates {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Checking for updates…").font(.callout).foregroundStyle(.secondary)
                    }
                } else if let updateEntry {
                    Label(PluginUpdatePresentation.availabilityText(updateEntry),
                          systemImage: "arrow.triangle.2.circlepath")
                        .font(.callout)
                        .foregroundStyle(theme.current.warning)
                } else {
                    Text("No update reported for v\(shownVersion(plugin)).")
                        .font(.callout).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    if updatePending {
                        ProgressView().controlSize(.small)
                        Text("Updating…").font(.callout).foregroundStyle(.secondary)
                    } else if plugin.origin == "claude" || updateEntry != nil {
                        // The re-fetch is Claude's one-click route; a Codex import
                        // (or a zip named claude-…) only updates when a check reports one.
                        updateButton
                    }
                    Button("Check for updates") { Task { await loadUpdate(force: true) } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        // A forced check runs `claude plugin marketplace update`; not during any update.
                        .disabled(checkingUpdates || updateCenter.isUpdating)
                }
                if let updateResult, !updateResult.message.isEmpty {
                    Text(updateResult.message)
                        .font(.caption)
                        .foregroundStyle(updateResult.failed ? theme.current.danger : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
    }

    @ViewBuilder
    private var updateButton: some View {
        let button = Button(PluginUpdatePresentation.buttonTitle(tier: updateEntry?.tier)) {
            updateCenter.startUpdate(name: pluginName, api: api, oneClick: oneClick, origin: .detail)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(checkingUpdates || updateCenter.isUpdating)
        // Same emphasis as the import sheet's "Update": tinted only when an
        // update is actually reported, plain for a speculative re-fetch.
        if updateEntry != nil {
            button.tint(theme.current.warning)
        } else {
            button
        }
    }

    // MARK: - Body sections

    @ViewBuilder
    private func descriptionBlock(_ p: PluginInfo) -> some View {
        if !p.description.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("About").font(.headline)
                Text(p.description).font(.body)
            }
        }
    }

    @ViewBuilder
    private func commandsBlock(_ p: PluginInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Slash commands (\(p.commands.count))").font(.headline)
            if p.commands.isEmpty {
                Text("None.").font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(p.commands) { c in
                    HStack(alignment: .top, spacing: 8) {
                        Text("/\(c.trigger)")
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(Color.accentColor)
                        Text(c.description)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func subagentsBlock(_ p: PluginInfo) -> some View {
        if !p.subagents.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Subagents (\(p.subagents.count))").font(.headline)
                ForEach(p.subagents) { s in
                    HStack(alignment: .top, spacing: 8) {
                        Text(s.name).font(.body.bold())
                        Text(s.description)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        // Skills count is exposed via skillCount; the server doesn't
        // currently ship a per-skill manifest endpoint we can render
        // here without an additional API. The count is shown on the
        // sidebar row; deeper introspection requires opening the
        // plugin directory in Finder.
        if p.skillCount > 0 {
            HStack(spacing: 6) {
                Image(systemName: "books.vertical")
                    .foregroundStyle(.secondary)
                Text("\(p.skillCount) skill\(p.skillCount == 1 ? "" : "s") loaded.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Vendor-package components LLM-IDE does not run — shown so the user knows
    /// what a Claude Code / Codex plugin brought along that stays inert here,
    /// rather than wondering why its hooks never fire.
    @ViewBuilder
    private func componentsBlock(_ plugin: PluginInfo) -> some View {
        if !plugin.pendingComponents.isEmpty || !plugin.unsupportedComponents.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Components").font(.headline)
                if plugin.pendingComponents.contains("mcp") {
                    Label(mcpSummary(plugin), systemImage: "bolt.horizontal.circle")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(plugin.unsupportedComponents, id: \.self) { component in
                    switch PluginTrustPresentation.componentStatus(component, plugin) {
                    case .agentEngine:
                        // LLM-IDE ignores it, but the Agent engine loads the whole
                        // package — "ignored" would be false once it is trusted.
                        Label(PluginTrustPresentation.agentEngineRowText(component, plugin),
                              systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.orange)
                    case .nativeOff:
                        Label("\(component) — not run while native plugin loading is off (Settings → Preferences)",
                              systemImage: "minus.circle")
                            .font(.callout).foregroundStyle(.secondary)
                    case .ignored:
                        Label("\(component) — unsupported, ignored", systemImage: "minus.circle")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// Hook trust. A plugin's hooks are shell commands its author wrote, so
    /// this is a deliberate, revocable grant that enabling the plugin does not
    /// give — the warning says exactly what turning it on means.
    @ViewBuilder
    private func hooksBlock(_ plugin: PluginInfo) -> some View {
        if plugin.hookCount > 0 || plugin.declaresHooks || !plugin.hookNotes.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(PluginTrustPresentation.hooksHeading(plugin)).font(.headline)
                if plugin.hookCount > 0 || plugin.declaresHooks {
                    Toggle(isOn: Binding(
                        get: { plugin.hooksTrusted },
                        // Granting runs the plugin's code with the app's access: ask
                        // first. Revoking is one click.
                        set: { newValue in
                            if newValue {
                                kindsShownForTrust = PluginTrustPresentation.shownKinds(plugin)
                                confirmingTrust = true
                            } else {
                                Task { await setHookTrust(false) }
                            }
                        }
                    )) {
                        Text(PluginTrustPresentation.trustLabel(plugin))
                    }
                    .toggleStyle(.switch)
                    .disabled(trustPending || !plugin.enabled)
                    Text(PluginTrustPresentation.trustExplanation(plugin))
                        .font(.caption)
                        .foregroundStyle(plugin.hooksTrusted ? .orange : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !plugin.enabled {
                        Text("Enable the plugin first — its hooks and scripts only run for an enabled plugin.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let trustError {
                        Text(trustError).font(.caption).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if !plugin.nativeDelivery {
                    // These notes describe what LLM-IDE's own hook handling
                    // skips. When the engine loads the plugin natively it runs
                    // those handlers itself, so showing them would be wrong.
                    ForEach(plugin.hookNotes, id: \.self) { note in
                        Label(note, systemImage: "minus.circle")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// MCP servers a plugin declares are registered but inert until consented
    /// in the MCP Plugins section — say where to go rather than just "pending".
    private func mcpSummary(_ plugin: PluginInfo) -> String {
        let n = plugin.mcpServerCount
        guard n > 0 else { return "MCP servers — declared, none registered" }
        return "\(n) MCP server\(n == 1 ? "" : "s") declared — consent to each under MCP Plugins to activate"
    }

    // MARK: - Data + actions

    private func setHookTrust(_ trusted: Bool, shownKinds: [String]? = nil) async {
        trustPending = true
        defer { trustPending = false }
        do {
            trustError = nil
            _ = try await api.setPluginHookTrust(
                name: pluginName, trusted: trusted,
                shownKinds: trusted ? shownKinds : nil)
            // The token bump below reloads this pane through its own onChange; a second
            // explicit refresh here only doubled the request.
            shell.markLibraryDirty()
        } catch {
            // A refused grant (the plugin changed since it was shown) must not wipe
            // the pane: reload so the new declaration is on screen, then say why.
            let message = error.localizedDescription
            await refresh()
            trustError = message
        }
    }

    /// Ask the server whether this plugin has an update. `force` (the button)
    /// also refreshes the marketplace catalogs and records the outcome;
    /// otherwise the center's short TTL applies.
    private func loadUpdate(force: Bool) async {
        guard showsUpdateBlock else { return }
        if force {
            await updateCenter.check(name: pluginName, api: api, oneClick: oneClick)
        } else {
            await updateCenter.refresh(api: api, oneClick: oneClick, force: false)
        }
    }

    /// Re-read without the spinner, so the pane does not flash on every change.
    private func refresh() async {
        guard let resp = try? await api.listPlugins() else { return }
        self.plugin = resp.plugins.first { $0.name == pluginName }
    }

    private func load() async {
        loaded = false
        loadError = nil
        do {
            let resp = try await api.listPlugins()
            self.plugin = resp.plugins.first { $0.name == pluginName }
        } catch {
            self.loadError = error.localizedDescription
        }
        loaded = true
    }

    private func toggle() async {
        guard let p = plugin else { return }
        togglePending = true
        defer { togglePending = false }
        actionError = nil
        do {
            try await api.togglePlugin(name: p.name, enabled: !p.enabled)
            shell.markLibraryDirty()
        } catch {
            actionError = error.localizedDescription
        }
    }

}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
