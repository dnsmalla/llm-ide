import SwiftUI

/// Detail pane for a registered MCP plugin: its command/args, per-user
/// consent + enable toggles, and Remove. Mirrors `LlmSourceDetailView`'s
/// load/toggle/remove shape.
///
/// This client never connects to or spawns the listed server — dispatch is
/// delegated entirely to the server's MCP config (extension/mcp/mcp-config.mjs), and only once this user has both
/// consented AND enabled it.
///
/// Mutations here bump `ShellState.libraryDirtyToken`, which the Library
/// sidebar watches — consenting to a server no longer leaves its row showing
/// the old state until a full Library reload.
struct McpPluginDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    @Environment(ShellState.self) private var shell
    let api: LlmIdeAPIClient
    let pluginId: String
    /// Read for `serverApiVersion` only — version controls need API v62+.
    @Environment(BackendManager.self) private var backend
    private let center = McpUpdateCenter.shared

    @State private var plugin: LlmIdeAPIClient.McpPluginInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var busy = false
    /// An action's failure. Kept apart from `loadError`: a failed toggle must not
    /// replace the whole pane (the server is fine, the user can retry).
    @State private var actionError: String?
    @State private var confirmingRemoval = false
    /// Typed into the inline credential field; never persisted client-side —
    /// it goes straight to the server vault and the field is cleared.
    @State private var credentialDraft = ""

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
                    infoBlock(plugin)
                    if supportsVersions { versionBlock(plugin) }
                    actionsRow
                } else {
                    Text("Plugin not found — it may have been removed.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: pluginId) { await load() }
        // A change made elsewhere (the sidebar row's consent / enable switches)
        // must reach this open pane too, without blanking it.
        .onChange(of: shell.libraryDirtyToken) { Task { await refresh() } }
        .confirmationDialog(
            LibraryRemoval.mcpServer(id: pluginId, name: plugin?.name ?? pluginId).dialogTitle,
            isPresented: $confirmingRemoval, titleVisibility: .visible
        ) {
            Button(LibraryRemoval.mcpServer(id: pluginId, name: "").confirmLabel, role: .destructive) {
                Task { await remove() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(LibraryRemoval.mcpServer(id: pluginId, name: "").message)
        }
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "bolt.horizontal.circle.fill")
                .font(.system(size: 28))
                .foregroundStyle(plugin?.enabled == true && plugin?.consented == true ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin?.name ?? pluginId).font(.title2.bold())
                if let plugin {
                    Text(McpUpdatePresentation.sourceLabel(source: plugin.source))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func infoBlock(_ p: LlmIdeAPIClient.McpPluginInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Details").font(.headline)
            LabeledContent(p.isHosted ? "URL" : "Command", value: p.endpointSummary)
            LabeledContent("Transport", value: p.transport)
            if let env = p.env, !env.isEmpty {
                LabeledContent("Environment", value: env.keys.sorted().joined(separator: ", "))
            }
            if let headers = p.headers, !headers.isEmpty {
                // Names only — the server redacts the values, which for a
                // hosted server is where its bearer token sits.
                LabeledContent("Headers", value: headers.keys.sorted().joined(separator: ", "))
            }
            if let cred = p.credential {
                LabeledContent("Credential", value: cred.label ?? cred.vaultKey)
                if p.credentialMissing {
                    // Registered but unauthenticated: the server is still
                    // passed to the CLI, so it will fail at connect time until
                    // the value is stored. Say so, and take the value here —
                    // this key lives in no other screen, so pointing the user
                    // elsewhere was pointing at nothing.
                    Text("No value stored for \(cred.vaultKey) — this server will fail to authenticate.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    HStack(spacing: 8) {
                        SecureField(cred.label ?? cred.vaultKey, text: $credentialDraft)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 280)
                        Button("Save Credential") { Task { await saveCredential(key: cred.vaultKey) } }
                            .disabled(busy || credentialDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            Toggle("Consented", isOn: Binding(
                get: { p.consented },
                set: { newValue in Task { await setConsented(newValue) } }
            ))
            .toggleStyle(.switch)
            .disabled(busy)
            Toggle("Enabled", isOn: Binding(
                get: { p.enabled },
                set: { newValue in Task { await setEnabled(newValue) } }
            ))
            .toggleStyle(.switch)
            .disabled(busy || !p.consented)
            if !p.consented {
                Text("Consent before enabling — an enabled-but-unconsented server is never offered to the agent.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Once enabled it is offered to the agent as mcp__\(p.id)__* tools.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            // The two facts the toggles do not say: where it works, and the
            // per-call cost of leaving it on.
            VStack(alignment: .leading, spacing: 2) {
                Text(McpUsageNotes.modeNote)
                Text(McpUsageNotes.costNote)
            }
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var supportsVersions: Bool {
        McpUpdatePresentation.isSupported(serverApiVersion: backend.serverApiVersion)
    }

    @ViewBuilder
    private func versionBlock(_ p: LlmIdeAPIClient.McpPluginInfo) -> some View {
        let working = center.inFlight.contains(p.id)
        let info = center.update(for: p.id)
        let isImport = p.source == "claude" || p.source == "codex"
        VStack(alignment: .leading, spacing: 6) {
            if let version = McpUpdatePresentation.versionText(package: p.package) {
                Text("Version").font(.headline)
                LabeledContent(p.package?.name ?? "Package", value: version)
                if let info, info.status == "unknown", let reason = info.reason {
                    Text("Could not look up the latest version: \(reason)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    if let title = McpUpdatePresentation.actionTitle(status: info?.status ?? "", latest: info?.latest) {
                        Button(title) { Task { await applyUpdate(p, latest: info?.latest) } }
                            .disabled(busy || working)
                    }
                    Button("Check for updates") {
                        Task { await center.check(api: api, force: true, reportTo: p.id) }
                    }
                    .disabled(busy || working || center.checking)
                    if working || center.checking { ProgressView().controlSize(.small) }
                }
            }
            if isImport, let changes = center.drift[p.id], !changes.isEmpty {
                Text(McpUpdatePresentation.driftText(changes: changes))
                    .font(.caption).foregroundStyle(.secondary)
                Button("Re-sync from \(p.source == "codex" ? "Codex" : "Claude Code")") {
                    Task { await applyResync(p) }
                }
                .disabled(busy || working)
            }
            if let result = center.results[p.id] {
                Text(result.message).font(.caption)
                    .foregroundStyle(result.failed ? theme.current.danger : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: p.id) {
            // Not while the list-load check is still in flight: a second check bumps the
            // generation, which discards the list check's answer and leaves the OTHER
            // servers' sidebar badges unset after the first open.
            if p.package != nil, center.update(for: p.id) == nil, !center.checking {
                await center.check(api: api, force: false)
            }
            if isImport { await center.loadDrift(id: p.id, api: api) }
        }
    }

    private func applyUpdate(_ p: LlmIdeAPIClient.McpPluginInfo, latest: String?) async {
        if await center.update(id: p.id, to: latest, expectArgs: p.args, api: api) {
            shell.markLibraryDirty()
        }
    }

    private func applyResync(_ p: LlmIdeAPIClient.McpPluginInfo) async {
        if await center.resync(id: p.id, api: api) { shell.markLibraryDirty() }
    }

    @ViewBuilder
    private var actionsRow: some View {
        HStack(spacing: 10) {
            Button("Remove", role: .destructive) { confirmingRemoval = true }
                .disabled(busy)
        }
    }

    // MARK: - Data + actions

    private func load() async {
        loaded = false
        loadError = nil
        do {
            let plugins = try await api.listMcpPlugins()
            self.plugin = plugins.first { $0.id == pluginId }
        } catch {
            self.loadError = error.localizedDescription
        }
        loaded = true
    }

    /// Re-read without the spinner, so the pane does not flash on every change.
    private func refresh() async {
        guard let plugins = try? await api.listMcpPlugins() else { return }
        self.plugin = plugins.first { $0.id == pluginId }
    }

    private func setConsented(_ consented: Bool) async {
        busy = true
        defer { busy = false }
        actionError = nil
        do {
            _ = try await api.consentMcpPlugin(id: pluginId, consented: consented)
            shell.markLibraryDirty()   // reloads this pane through its own onChange
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func setEnabled(_ enabled: Bool) async {
        busy = true
        defer { busy = false }
        actionError = nil
        do {
            _ = try await api.toggleMcpPlugin(id: pluginId, enabled: enabled)
            shell.markLibraryDirty()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        actionError = nil
        do {
            try await api.removeMcpPlugin(id: pluginId)
            // The server is gone: leave the pane instead of showing live toggles
            // for something that no longer exists.
            if case .mcpPlugin(let selected) = shell.librarySelection, selected == pluginId {
                shell.librarySelection = nil
            }
            shell.markLibraryDirty()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Write the server's declared credential straight into the vault under the
    /// key the registry names. The value never touches client storage.
    private func saveCredential(key: String) async {
        let value = credentialDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        busy = true
        defer { busy = false }
        actionError = nil
        do {
            try await api.setSecret(key: key, value: value)
            credentialDraft = ""
            shell.markLibraryDirty()
        } catch {
            actionError = error.localizedDescription
        }
    }
}
