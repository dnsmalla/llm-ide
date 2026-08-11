import SwiftUI

/// Detail pane for a registered LLM source: version/location/ref, its
/// discovered skills/agents/hooks/MCP servers, and the Update / Reveal /
/// Remove actions the design doc calls for. The builtin source shows
/// "Install" instead of "Update" when its submodule isn't checked out (the
/// only source kind with a real re-fetch path when missing — a local/git
/// source with a missing directory can't be revived by "Update" either,
/// since fetch/checkout both need the dir to exist; the fix there is
/// Remove + re-add). Remove never shows for builtin — the server rejects
/// it anyway, this just avoids a pointless round trip.
///
/// Agents, hooks, and MCP servers are DISPLAY ONLY — this view never
/// invokes a listed agent, executes a listed hook's command, or spawns a
/// listed MCP server. That's true for every source including builtin; only
/// the hardcoded server-side handlers in route.mjs are ever actually run.
///
/// Mutations here don't push a refresh back to the sidebar's own
/// `[LlmSourceInfo]` state — matching `PluginDetailView`, which has the same
/// gap (toggling a plugin's enabled state in its detail pane doesn't
/// refresh `LibraryView.plugins` either). The sidebar catches up on the
/// next full Library reload.
struct LlmSourceDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    let api: LlmIdeAPIClient
    let sourceId: String

    @State private var source: LlmIdeAPIClient.LlmSourceInfo?
    @State private var discovery: LlmIdeAPIClient.LlmSourceDiscoveryDetail?
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
                } else if let source {
                    infoBlock(source)
                    actionsRow(source)
                    if let discovery {
                        agentsBlock(discovery.agents)
                        hooksBlock(discovery.hooks)
                        mcpServersBlock(discovery.mcpServers)
                    }
                } else {
                    Text("Source not found — it may have been removed.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: sourceId) { await load() }
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "books.vertical.fill")
                .font(.system(size: 28))
                .foregroundStyle(source?.enabled == true ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(source?.name ?? sourceId).font(.title2.bold())
                if let source, let v = source.version, !v.isEmpty {
                    Text("v\(v)").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let source {
                Toggle("Enabled", isOn: Binding(
                    get: { source.enabled },
                    set: { newValue in Task { await toggle(newValue) } }
                ))
                .toggleStyle(.switch)
                .disabled(busy)
            }
        }
    }

    @ViewBuilder
    private func infoBlock(_ s: LlmIdeAPIClient.LlmSourceInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Details").font(.headline)
            LabeledContent("Origin", value: s.origin)
            if let loc = s.location { LabeledContent("Location", value: loc) }
            if let ref = s.ref { LabeledContent("Ref", value: ref) }
            LabeledContent("Skills", value: "\(s.skillCount)")
            LabeledContent("Agents", value: "\(s.agentCount)")
            LabeledContent("Hooks", value: "\(s.hookCount)")
            LabeledContent("MCP servers", value: "\(s.mcpCount)")
            if !s.installed {
                Text(s.builtin
                     ? "The bundled .skills submodule isn't checked out. Install to fetch it."
                     : "This source's directory is missing on disk. Remove and re-add it.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func agentsBlock(_ agents: [LlmIdeAPIClient.LlmSourceAgent]) -> some View {
        if !agents.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Agents (\(agents.count))").font(.headline)
                ForEach(agents) { a in
                    HStack(alignment: .top, spacing: 8) {
                        Text(a.name).font(.body.bold())
                        Text(a.description).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func hooksBlock(_ hooks: [LlmIdeAPIClient.LlmSourceHook]) -> some View {
        if !hooks.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Hooks (\(hooks.count))").font(.headline)
                Text("Listed for visibility only — hooks from a registered source are never executed.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(hooks) { h in
                    HStack(alignment: .top, spacing: 8) {
                        Text(h.event).font(.body.bold())
                        if let matcher = h.matcher {
                            Text(matcher).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(h.command)
                            .font(.system(.callout, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func mcpServersBlock(_ servers: [LlmIdeAPIClient.LlmSourceMcpServer]) -> some View {
        if !servers.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("MCP servers (\(servers.count))").font(.headline)
                Text("Listed for visibility only — this app never connects to or spawns a source's MCP servers.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(servers) { m in
                    HStack(alignment: .top, spacing: 8) {
                        Text(m.name).font(.body.bold())
                        Text(([m.command] + m.args).joined(separator: " "))
                            .font(.system(.callout, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func actionsRow(_ s: LlmIdeAPIClient.LlmSourceInfo) -> some View {
        HStack(spacing: 10) {
            Button(s.builtin && !s.installed ? "Install" : "Update") { Task { await update() } }
                .disabled(busy || (!s.builtin && !s.installed))
            if s.location != nil, s.installed {
                Button("Reveal in Finder") { reveal(s) }
                    .disabled(busy)
            }
            if !s.builtin {
                Button("Remove", role: .destructive) { Task { await remove() } }
                    .disabled(busy)
            }
        }
    }

    // MARK: - Data + actions

    private func load() async {
        loaded = false
        loadError = nil
        do {
            let sources = try await api.listLlmSources()
            self.source = sources.first { $0.id == sourceId }
            self.discovery = try? await api.llmSourceDiscovery(id: sourceId)
        } catch {
            self.loadError = error.localizedDescription
        }
        loaded = true
    }

    private func toggle(_ enabled: Bool) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.toggleLlmSource(id: sourceId, enabled: enabled)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func update() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.updateLlmSource(id: sourceId)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeLlmSource(id: sourceId)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func reveal(_ s: LlmIdeAPIClient.LlmSourceInfo) {
        guard let loc = s.location else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: loc, isDirectory: true)])
    }
}
