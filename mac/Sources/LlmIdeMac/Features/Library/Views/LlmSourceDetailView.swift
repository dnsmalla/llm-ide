import SwiftUI

/// Detail pane for a registered LLM source: version/location/ref, its
/// discovered skills/agents/commands/templates/hooks/MCP servers, and the
/// Update / Reveal / Remove actions. The builtin source shows "Install"
/// instead of "Update" when its submodule isn't checked out (the only source
/// kind with a real re-fetch path when missing — a local/git source with a
/// missing directory can't be revived by "Update" either; the fix there is
/// Remove + re-add). Remove never shows for builtin — the server rejects it.
///
/// Skills, agents, commands, and templates each carry a CHECKBOX: the user's
/// per-item selection. An unchecked item leaves the chat "/" menu, the phone,
/// Loop, and the Doc Gen / Visual menus; for Central Skills it also leaves the
/// open project's installed skills (`.claude/skills`, …), which is why a
/// Central Skills change re-runs the project install. Hooks and MCP servers
/// stay whole-source and have no checkbox.
///
/// **Update** pulls the source (the server refuses rather than discard local
/// edits or commits), then re-links the open project's skills and reports
/// what was added, removed, and corrected. The upstream status line comes from
/// `GET …/updates`; a local folder has no remote, so its action is Rescan.
///
/// Nothing listed here is ever invoked, executed, or spawned from this view.
/// Mutations bump `ShellState.libraryDirtyToken` (the sidebar reloads) and
/// post `.llmSourcesChanged` (the chat "/" menu drops its cache).
struct LlmSourceDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var projectStore: ProjectStore
    @Environment(ShellState.self) private var shell
    let api: LlmIdeAPIClient
    let sourceId: String

    @State private var source: LlmIdeAPIClient.LlmSourceInfo?
    @State private var discovery: LlmIdeAPIClient.LlmSourceDiscoveryDetail?
    @State private var updateStatus: LlmIdeAPIClient.LlmSourceUpdateStatus?
    @State private var checkingUpdates = false
    @State private var loaded = false
    @State private var loadError: String?
    @State private var busy = false
    @State private var resultMessage: String?
    /// Debounces the project re-install a Central Skills checkbox triggers, so
    /// clicking through several boxes runs install.sh once, not per click.
    @State private var reinstallTask: Task<Void, Never>?
    /// A checkbox write is on the wire. Boxes are disabled until it lands, so
    /// two quick clicks can't reach the server out of order.
    @State private var itemWriteInFlight = false

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
                        itemsBlock("Skills", kind: .skill, items: discovery.skills ?? [])
                        itemsBlock("Agents", kind: .agent, items: discovery.agents,
                                   caption: "Agents from a source aren't run by LLM-IDE yet — your selection is saved for when they are.")
                        itemsBlock("Commands", kind: .command, items: discovery.commands ?? [])
                        itemsBlock("Templates", kind: .template, items: discovery.templates ?? [])
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
        .task(id: sourceId) {
            await load()
            await checkForUpdate(force: false)
        }
        .onDisappear { reinstallTask?.cancel() }
        .alert("LLM source", isPresented: Binding(
            get: { resultMessage != nil },
            set: { if !$0 { resultMessage = nil } }
        )) {
            Button("OK") { resultMessage = nil }
        } message: {
            Text(resultMessage ?? "")
        }
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
            LabeledContent("Commands", value: "\(s.commandCount)")
            LabeledContent("Templates", value: "\(s.templateCount)")
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

    /// One selectable kind (skills, agents, commands, or templates): a
    /// checkbox per item, a **New** badge on items the last update added, and
    /// All / None for the section.
    @ViewBuilder
    private func itemsBlock(_ title: String, kind: LlmIdeAPIClient.LlmSourceItemKind,
                            items: [LlmIdeAPIClient.LlmSourceItem], caption: String? = nil) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Text("\(title) (\(items.filter(\.enabled).count) of \(items.count) on)").font(.headline)
                    Spacer()
                    Button("All") { Task { await setItems(kind, names: items.filter { !$0.enabled }.map(\.name), enabled: true) } }
                        .disabled(busy || itemWriteInFlight || items.allSatisfy(\.enabled))
                    Button("None") { Task { await setItems(kind, names: items.filter(\.enabled).map(\.name), enabled: false) } }
                        .disabled(busy || itemWriteInFlight || items.allSatisfy { !$0.enabled })
                }
                .buttonStyle(.link)
                .controlSize(.small)
                if let caption {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(items) { item in
                    Toggle(isOn: Binding(
                        get: { item.enabled },
                        set: { on in Task { await setItems(kind, names: [item.name], enabled: on) } }
                    )) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(kind == .command ? "/\(item.name)" : item.name)
                                .font(kind == .command ? .system(.body, design: .monospaced).bold() : .body.bold())
                            if item.isNew {
                                Text("New")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(Color.accentColor)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(Color.accentColor.opacity(0.15))
                                    .clipShape(Capsule())
                            }
                            if !item.description.isEmpty {
                                Text(item.description).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        .opacity(item.enabled ? 1 : 0.55)
                    }
                    .toggleStyle(.checkbox)
                    .disabled(busy || itemWriteInFlight)
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
        VStack(alignment: .leading, spacing: 8) {
            updateStatusLine
            HStack(spacing: 10) {
                primaryUpdateButton(s)
                Button(checkingUpdates ? "Checking…" : "Check for updates") {
                    Task { await checkForUpdate(force: true) }
                }
                .disabled(busy || checkingUpdates || !s.installed || updateStatus?.isLocal == true)
                if s.location != nil, s.installed {
                Button("Reveal in Finder") { reveal(s) }
                    .disabled(busy)
            }
                if !s.builtin {
                    Button("Remove", role: .destructive) { Task { await remove() } }
                        .disabled(busy)
                }
                if busy { ProgressView().controlSize(.small) }
            }
        }
    }

    @ViewBuilder
    private func primaryUpdateButton(_ s: LlmIdeAPIClient.LlmSourceInfo) -> some View {
        let title = s.builtin && !s.installed ? "Install" : (updateStatus?.isLocal == true ? "Rescan" : "Update")
        if updateStatus?.updateAvailable == true {
            Button(title) { Task { await update() } }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
        } else {
            Button(title) { Task { await update() } }
                .disabled(busy || (!s.builtin && !s.installed))
        }
    }

    /// Upstream status, in words — shown above the actions.
    @ViewBuilder
    private var updateStatusLine: some View {
        if let st = updateStatus {
            switch st.status {
            case "update-available":
                Label("Update available", systemImage: "arrow.down.circle.fill")
                    .foregroundStyle(Color.accentColor).font(.callout.bold())
            case "up-to-date":
                Label("Up to date", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary).font(.callout)
            case "local":
                Label("Local folder — Rescan picks up changes made on disk.", systemImage: "folder")
                    .foregroundStyle(.secondary).font(.callout)
            case "diverged":
                Label(st.message ?? "This source has local commits; update it with git.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(theme.current.danger).font(.callout)
            default:
                Label("Couldn't check for updates\(st.message.map { ": \($0)" } ?? ".")", systemImage: "questionmark.circle")
                    .foregroundStyle(.secondary).font(.callout)
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
            announceChange()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func checkForUpdate(force: Bool) async {
        checkingUpdates = true
        defer { checkingUpdates = false }
        // Never an error surface: an unreachable server just leaves no status.
        let statuses = try? await api.llmSourceUpdates(force: force)
        // A superseded task (the view moved on) must not overwrite what the
        // current one found.
        guard !Task.isCancelled else { return }
        updateStatus = statuses?.first { $0.id == sourceId }
    }

    /// Check/uncheck items. Applied to local state first so the box flips
    /// immediately; a server refusal reloads the truth and says why.
    private func setItems(_ kind: LlmIdeAPIClient.LlmSourceItemKind, names: [String], enabled: Bool) async {
        guard !names.isEmpty, !itemWriteInFlight else { return }
        itemWriteInFlight = true
        defer { itemWriteInFlight = false }
        applyLocally(kind, names: Set(names), enabled: enabled)
        do {
            try await api.setLlmSourceItems(sourceId: sourceId, kind: kind, names: names, enabled: enabled)
            // Re-read what the server stored, so the boxes show the truth.
            if let list = try? await api.listLlmSources() { source = list.first { $0.id == sourceId } }
            if let fresh = try? await api.llmSourceDiscovery(id: sourceId) { discovery = fresh }
            announceChange()
            // Central Skills feeds project installs; templates never install.
            if source?.builtin == true, kind != .template { scheduleProjectReinstall() }
        } catch {
            resultMessage = "Couldn't save the selection: \(error.localizedDescription)"
            await load()
        }
    }

    private func applyLocally(_ kind: LlmIdeAPIClient.LlmSourceItemKind, names: Set<String>, enabled: Bool) {
        guard var d = discovery else { return }
        func flip(_ list: [LlmIdeAPIClient.LlmSourceItem]) -> [LlmIdeAPIClient.LlmSourceItem] {
            list.map { item in
                var copy = item
                if names.contains(item.name) { copy.enabled = enabled }
                return copy
            }
        }
        switch kind {
        case .skill: d.skills = flip(d.skills ?? [])
        case .agent: d.agents = flip(d.agents)
        case .command: d.commands = flip(d.commands ?? [])
        case .template: d.templates = flip(d.templates ?? [])
        }
        discovery = d
    }

    private func scheduleProjectReinstall() {
        reinstallTask?.cancel()
        reinstallTask = Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled else { return }
            if case .failure(let err) = await reinstallProjectSkills() {
                resultMessage = "Saved, but the project's skills couldn't be re-linked: \(err.localizedDescription)"
            }
        }
    }

    /// Re-run the open project's skills install so its `.claude/skills` (and
    /// the other tool folders) match the kit and the selection. Returns the
    /// project's name on success, nil when no project is open.
    private func reinstallProjectSkills() async -> Result<String?, Error> {
        guard let ap = projectStore.activeProject else { return .success(nil) }
        do {
            _ = try await api.installProjectSkills(path: ap.localPath, language: ap.bundle.settings.language)
            return .success(ap.bundle.displayName)
        } catch {
            return .failure(error)
        }
    }

    private func update() async {
        busy = true
        defer { busy = false }
        // This run re-links the project itself; a pending checkbox re-install
        // would only repeat it.
        reinstallTask?.cancel()
        let wasInstall = source?.builtin == true && source?.installed == false
        do {
            let result = try await api.updateLlmSource(id: sourceId)
            var projectName: String?
            var note = ""
            // Only Central Skills is installed into projects.
            if source?.builtin == true {
                switch await reinstallProjectSkills() {
                case .success(let name): projectName = name
                case .failure(let err): note = " The project's skills couldn't be re-linked: \(err.localizedDescription)"
                }
            }
            await load()
            announceChange()
            // Not forced: the server already dropped this source's cached
            // status, and forcing would re-check every other source too.
            await checkForUpdate(force: false)
            resultMessage = result.summary(sourceName: source?.name ?? sourceId, projectSkills: projectName,
                                           wasInstall: wasInstall) + note
        } catch {
            resultMessage = "Update failed: \(error.localizedDescription)"
        }
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeLlmSource(id: sourceId)
            // Leave the pane: it would keep showing the removed source with
            // live controls whose next toggle 404s. The sibling detail views
            // (MCP, connectors) clear the selection the same way.
            shell.librarySelection = nil
            announceChange()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func announceChange() {
        shell.markLibraryDirty()
        NotificationCenter.default.post(name: .llmSourcesChanged, object: nil)
    }

    private func reveal(_ s: LlmIdeAPIClient.LlmSourceInfo) {
        guard let loc = s.location else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: loc, isDirectory: true)])
    }
}
