// Settings → Plugins. Lists every plugin installed under the server's
// per-user plugin directory, with a per-plugin enable toggle and a
// summary of the skills + slash commands each plugin contributes.
//
// Plugins are added by dropping a directory into the plugin dir;
// "Reveal in Finder" opens the folder so the user can install one.
// "Reload" tells the server to re-scan after a fresh install.

import SwiftUI
import AppKit

struct PluginsSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore

    let api: MeetNotesAPIClient

    @State private var plugins: [PluginInfo] = []
    @State private var pluginDir: String = ""
    @State private var loading = false
    @State private var installing = false
    @State private var error: String?
    @State private var pendingToggles: Set<String> = []   // names mid-flight
    @State private var pendingUninstalls: Set<String> = []
    @State private var confirmReplace: PluginReplaceContext?

    struct PluginReplaceContext: Identifiable {
        let id = UUID()
        let zipURL: URL
        let existingName: String
    }

    var body: some View {
        SettingsSectionCard(icon: "puzzlepiece.extension", title: "Plugins") {
            VStack(alignment: .leading, spacing: Spacing.md) {
                SettingsHint("Plugins add slash commands and agent skills. Drop a plugin folder into the directory below, then hit Reload. Toggle each plugin to enable it for your account.")

                headerRow

                if loading && plugins.isEmpty {
                    ProgressView().controlSize(.small)
                } else if plugins.isEmpty {
                    Text("No plugins installed yet.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                } else {
                    ForEach(plugins) { plugin in
                        pluginRow(plugin)
                        if plugin.id != plugins.last?.id {
                            Divider().opacity(0.4)
                        }
                    }
                }

                if let err = error {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .lineLimit(3)
                }
            }
        }
        .task { await refresh() }
    }

    // MARK: - Header

    private var headerRow: some View {
        let t = theme.current
        return HStack(spacing: Spacing.sm) {
            if !pluginDir.isEmpty {
                Text(pluginDir)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button {
                Task { await installFromFile() }
            } label: {
                Label("Install from .zip…", systemImage: "tray.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(installing)

            Button {
                revealInFinder()
            } label: {
                Label("Reveal in Finder", systemImage: "folder")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(pluginDir.isEmpty)

            Button {
                Task { await reload() }
            } label: {
                Label("Reload", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(loading)
        }
    }

    private func pluginRow(_ plugin: PluginInfo) -> some View {
        let t = theme.current
        let inFlight = pendingToggles.contains(plugin.name)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(plugin.displayName.isEmpty ? plugin.name : plugin.displayName)
                        .font(Typography.body)
                        .foregroundStyle(t.text)
                    Text("\(plugin.name) · \(plugin.version)\(plugin.author.isEmpty ? "" : " · by \(plugin.author)")")
                        .font(.system(size: 10))
                        .foregroundStyle(t.textMuted)
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { plugin.enabled },
                    set: { newValue in Task { await toggle(plugin, enabled: newValue) } }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(inFlight)

                Menu {
                    Button(role: .destructive) {
                        Task { await uninstall(plugin) }
                    } label: {
                        Label("Uninstall", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(t.textMuted)
                }
                .menuStyle(.borderlessButton)
                .frame(width: 22)
                .disabled(pendingUninstalls.contains(plugin.name))
            }
            if !plugin.description.isEmpty {
                Text(plugin.description)
                    .font(.system(size: 11))
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if plugin.skillCount > 0 {
                    Label("\(plugin.skillCount) skill\(plugin.skillCount == 1 ? "" : "s")", systemImage: "sparkles")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 10))
                        .foregroundStyle(t.textMuted)
                }
                if !plugin.commands.isEmpty {
                    let triggers = plugin.commands.map { "/\($0.trigger)" }.joined(separator: " ")
                    Label(triggers, systemImage: "command")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                }
                if !plugin.subagents.isEmpty {
                    let names = plugin.subagents.map { "@\($0.name)" }.joined(separator: " ")
                    Label(names, systemImage: "person.2")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                        .help(plugin.subagents.map { "@\($0.name): \($0.description)" }.joined(separator: "\n"))
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Actions

    private func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let resp = try await api.listPlugins()
            await MainActor.run {
                self.plugins = resp.plugins
                self.pluginDir = resp.pluginDir
                self.error = nil
            }
        } catch {
            await MainActor.run { self.error = "Failed to load plugins: \(error.localizedDescription)" }
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            _ = try await api.reloadPlugins()
            await refresh()
        } catch {
            await MainActor.run { self.error = "Reload failed: \(error.localizedDescription)" }
        }
    }

    private func toggle(_ plugin: PluginInfo, enabled: Bool) async {
        pendingToggles.insert(plugin.name)
        defer { pendingToggles.remove(plugin.name) }
        do {
            try await api.togglePlugin(name: plugin.name, enabled: enabled)
            await refresh()
        } catch {
            await MainActor.run { self.error = "Toggle failed: \(error.localizedDescription)" }
        }
    }

    private func revealInFinder() {
        guard !pluginDir.isEmpty else { return }
        let url = URL(fileURLWithPath: pluginDir)
        // Create the directory if missing so Finder doesn't bounce.
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func installFromFile() async {
        // Run NSOpenPanel on the main thread, capture the picked URL,
        // then upload off-main.
        let panel = await MainActor.run { () -> NSOpenPanel in
            let p = NSOpenPanel()
            p.title = "Choose plugin .zip"
            p.allowedContentTypes = [.zip]
            p.allowsMultipleSelection = false
            p.canChooseDirectories = false
            return p
        }
        let response = await MainActor.run { panel.runModal() }
        guard response == .OK, let url = await MainActor.run(body: { panel.url }) else { return }
        await performInstall(zipURL: url, replace: false)
    }

    private func performInstall(zipURL: URL, replace: Bool) async {
        installing = true
        defer { installing = false }
        do {
            let resp = try await api.installPlugin(zipURL: zipURL, replace: replace)
            await MainActor.run {
                self.error = nil
            }
            await refresh()
            // Surface a quick success message via the error slot (it's
            // the only banner the section has today). Cleared on the
            // next refresh tick.
            await MainActor.run {
                self.error = "Installed \(resp.plugin.displayName) v\(resp.plugin.version)" +
                    (resp.plugin.replaced ? " (replaced existing)" : "")
            }
        } catch let APIError.http(_, code, message, _) where code == "INSTALL_FAILED" && message.contains("already installed") {
            // 409 — surface a replace prompt via the sheet.
            await MainActor.run {
                self.confirmReplace = PluginReplaceContext(zipURL: zipURL, existingName: "(see error)")
                self.error = message
            }
        } catch {
            await MainActor.run {
                self.error = "Install failed: \(error.localizedDescription)"
            }
        }
    }

    private func uninstall(_ plugin: PluginInfo) async {
        pendingUninstalls.insert(plugin.name)
        defer { pendingUninstalls.remove(plugin.name) }
        do {
            _ = try await api.uninstallPlugin(name: plugin.name)
            await refresh()
        } catch {
            await MainActor.run { self.error = "Uninstall failed: \(error.localizedDescription)" }
        }
    }
}
