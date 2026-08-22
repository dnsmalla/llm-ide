import SwiftUI

/// Detail pane for a registered MCP plugin: its command/args, per-user
/// consent + enable toggles, and Remove. Mirrors `LlmSourceDetailView`'s
/// load/toggle/remove shape.
///
/// This client never connects to or spawns the listed server — dispatch is
/// delegated entirely to the Claude CLI's `--mcp-config` on the server side
/// (extension/mcp/mcp-config.mjs), and only once this user has both
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

    @State private var plugin: LlmIdeAPIClient.McpPluginInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var busy = false
    /// Typed into the inline credential field; never persisted client-side —
    /// it goes straight to the server vault and the field is cleared.
    @State private var credentialDraft = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if !loaded {
                    ProgressView().controlSize(.small)
                } else if let err = loadError {
                    Text(err).foregroundStyle(theme.current.danger).font(.callout)
                } else if let plugin {
                    infoBlock(plugin)
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
                    Text(plugin.source == "claude" ? "Imported from Claude Code" : "Manually registered")
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
                Text("Consent before enabling — an enabled-but-unconsented server never reaches the Claude CLI.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Reaches the Claude CLI's --mcp-config as mcp__\(p.id)__* once enabled.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var actionsRow: some View {
        HStack(spacing: 10) {
            Button("Remove", role: .destructive) { Task { await remove() } }
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

    private func setConsented(_ consented: Bool) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.consentMcpPlugin(id: pluginId, consented: consented)
            shell.markLibraryDirty()
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func setEnabled(_ enabled: Bool) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.toggleMcpPlugin(id: pluginId, enabled: enabled)
            shell.markLibraryDirty()
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeMcpPlugin(id: pluginId)
            shell.markLibraryDirty()
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Write the server's declared credential straight into the vault under the
    /// key the registry names. The value never touches client storage.
    private func saveCredential(key: String) async {
        let value = credentialDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.setSecret(key: key, value: value)
            credentialDraft = ""
            shell.markLibraryDirty()
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }
}
