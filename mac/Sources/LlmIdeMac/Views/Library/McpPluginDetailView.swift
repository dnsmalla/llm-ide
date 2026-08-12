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
/// Mutations here don't push a refresh back to the sidebar's own
/// `[McpPluginInfo]` state — matching `LlmSourceDetailView`'s same gap; the
/// sidebar catches up on the next full Library reload.
struct McpPluginDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    let api: LlmIdeAPIClient
    let pluginId: String

    @State private var plugin: LlmIdeAPIClient.McpPluginInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var busy = false

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
            LabeledContent("Command", value: ([p.command] + p.args).joined(separator: " "))
            if let env = p.env, !env.isEmpty {
                LabeledContent("Environment", value: env.keys.sorted().joined(separator: ", "))
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
        } catch {
            loadError = error.localizedDescription
        }
    }
}
