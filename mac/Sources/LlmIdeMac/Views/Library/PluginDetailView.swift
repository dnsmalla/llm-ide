import SwiftUI

/// Summary for an installed plugin — listing its skills, slash commands
/// and subagents, with an inline enable toggle. Install lives in the
/// Library Plugins-section header menu; uninstall in that section's row
/// context menu. (Plugin management is wholly in Library now — there is no
/// Settings → Plugins.)
struct PluginDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    let api: LlmIdeAPIClient
    let pluginName: String

    @State private var plugin: PluginInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var togglePending = false
    @State private var trustPending = false

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
        .task(id: pluginName) { await load() }
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
                    Label("\(component) — unsupported, ignored", systemImage: "minus.circle")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Hook trust. A plugin's hooks are shell commands its author wrote, so
    /// this is a deliberate, revocable grant that enabling the plugin does not
    /// give — the warning says exactly what turning it on means.
    @ViewBuilder
    private func hooksBlock(_ plugin: PluginInfo) -> some View {
        if plugin.hookCount > 0 || !plugin.hookNotes.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Hooks").font(.headline)
                if plugin.hookCount > 0 {
                    Toggle(isOn: Binding(
                        get: { plugin.hooksTrusted },
                        set: { newValue in Task { await setHookTrust(newValue) } }
                    )) {
                        Text("Trust hooks (\(plugin.hookCount) handler\(plugin.hookCount == 1 ? "" : "s"))")
                    }
                    .toggleStyle(.switch)
                    .disabled(trustPending || !plugin.enabled)
                    Text(plugin.hooksTrusted
                         ? "This plugin's hook commands run during a turn, with the same access as the app."
                         : "Turning this on lets this plugin run shell commands from its hooks file during a turn. Leave it off unless you trust the author.")
                        .font(.caption)
                        .foregroundStyle(plugin.hooksTrusted ? .orange : .secondary)
                    if !plugin.enabled {
                        Text("Enable the plugin first — hooks only run for an enabled plugin.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                ForEach(plugin.hookNotes, id: \.self) { note in
                    Label(note, systemImage: "minus.circle")
                        .font(.caption).foregroundStyle(.secondary)
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

    private func setHookTrust(_ trusted: Bool) async {
        trustPending = true
        defer { trustPending = false }
        do {
            _ = try await api.setPluginHookTrust(name: pluginName, trusted: trusted)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
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
        do {
            try await api.togglePlugin(name: p.name, enabled: !p.enabled)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
