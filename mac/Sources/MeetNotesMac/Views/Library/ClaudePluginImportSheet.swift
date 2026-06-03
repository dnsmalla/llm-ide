import SwiftUI

/// Sheet for browsing and importing Claude Code plugins. Two tabs:
/// "Installed" (plugins already in Claude Code) and "Marketplace"
/// (available from Claude plugin catalogs).
/// Includes search/filter and "Update" vs "Import" distinction.
struct ClaudePluginImportSheet: View {
    let api: MeetNotesAPIClient
    let onDismiss: () -> Void
    let onImported: () -> Void

    @State private var tab: Tab = .installed
    @State private var installedPlugins: [ClaudePlugin] = []
    @State private var marketplacePlugins: [ClaudeMarketplacePlugin] = []
    @State private var loading = true
    @State private var error: String?
    @State private var importingName: String?
    @State private var importMessage: String?
    @State private var searchText: String = ""

    enum Tab: String, CaseIterable {
        case installed = "Installed in Claude"
        case marketplace = "Marketplace"
    }

    // MARK: - Filtered lists

    private var filteredInstalled: [ClaudePlugin] {
        guard !searchText.isEmpty else { return installedPlugins }
        let q = searchText.lowercased()
        return installedPlugins.filter { $0.name.lowercased().contains(q) }
    }

    private var filteredMarketplace: [ClaudeMarketplacePlugin] {
        guard !searchText.isEmpty else { return marketplacePlugins }
        let q = searchText.lowercased()
        return marketplacePlugins.filter {
            $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            // Search field
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                TextField("Filter plugins\u{2026}", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.callout)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            if loading {
                Spacer()
                ProgressView("Scanning Claude Code plugins\u{2026}")
                    .controlSize(.small)
                Spacer()
            } else if let err = error {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title2).foregroundStyle(.secondary)
                    Text(err).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await load() } }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                Spacer()
            } else {
                list
            }

            if let msg = importMessage {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text(msg).font(.caption)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
        .frame(width: 520, height: 500)
        .task { await load() }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Import from Claude Code")
                    .font(.headline)
                Text("Browse and import plugins from your Claude Code installation")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Done") { onDismiss() }
                .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(16)
    }

    // MARK: - List

    @ViewBuilder
    private var list: some View {
        switch tab {
        case .installed:
            if filteredInstalled.isEmpty {
                if !searchText.isEmpty {
                    emptyState(
                        icon: "magnifyingglass",
                        title: "No matches",
                        subtitle: "No installed plugins match \"\(searchText)\"."
                    )
                } else {
                    emptyState(
                        icon: "puzzlepiece.extension",
                        title: "No Claude Code plugins found",
                        subtitle: "Install plugins in Claude Code first, then import them here."
                    )
                }
            } else {
                List(filteredInstalled) { plugin in
                    installedRow(plugin)
                }
                .listStyle(.inset)
            }
        case .marketplace:
            if filteredMarketplace.isEmpty {
                if !searchText.isEmpty {
                    emptyState(
                        icon: "magnifyingglass",
                        title: "No matches",
                        subtitle: "No marketplace plugins match \"\(searchText)\"."
                    )
                } else {
                    emptyState(
                        icon: "building.columns",
                        title: "No marketplace data",
                        subtitle: "Open Claude Code to sync the plugin marketplace, then come back here."
                    )
                }
            } else {
                List(filteredMarketplace) { plugin in
                    marketplaceRow(plugin)
                }
                .listStyle(.inset)
            }
        }
    }

    // MARK: - Rows

    private func installedRow(_ plugin: ClaudePlugin) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension.fill")
                .foregroundStyle(.teal)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(plugin.name).font(.callout.weight(.medium))
                HStack(spacing: 4) {
                    Text("v\(plugin.version)").font(.caption2).foregroundStyle(.secondary)
                    if plugin.skillCount > 0 {
                        Text("\u{00B7}").foregroundStyle(.tertiary)
                        Text("\(plugin.skillCount) skill\(plugin.skillCount == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if plugin.commandCount > 0 {
                        Text("\u{00B7}").foregroundStyle(.tertiary)
                        Text("\(plugin.commandCount) cmd\(plugin.commandCount == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if plugin.hasUpdate {
                        Text("\u{00B7}").foregroundStyle(.tertiary)
                        Text("update available")
                            .font(.caption2).foregroundStyle(.orange)
                    }
                }
            }
            Spacer()
            actionButton(name: plugin.name, source: "installed",
                         alreadyImported: plugin.alreadyImported,
                         hasUpdate: plugin.hasUpdate)
        }
        .padding(.vertical, 2)
    }

    private func marketplaceRow(_ plugin: ClaudeMarketplacePlugin) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "puzzlepiece.extension")
                .foregroundStyle(plugin.installedInClaude ? .teal : .secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(plugin.name).font(.callout.weight(.medium))
                    if plugin.hasSkills {
                        badge("skills", color: .green)
                    }
                    if plugin.hasCommands {
                        badge("cmds", color: .blue)
                    }
                }
                if !plugin.description.isEmpty {
                    Text(plugin.description)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            actionButton(name: plugin.name, source: "marketplace",
                         alreadyImported: plugin.alreadyImported,
                         hasUpdate: false)
        }
        .padding(.vertical, 2)
    }

    /// Shows "Import", "Update", checkmark, or spinner depending on state.
    @ViewBuilder
    private func actionButton(name: String, source: String,
                              alreadyImported: Bool, hasUpdate: Bool) -> some View {
        if importingName == name {
            ProgressView().controlSize(.small)
        } else if alreadyImported && hasUpdate {
            Button("Update") {
                Task { await doImport(name: name, source: source, isUpdate: true) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(.orange)
        } else if alreadyImported {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .help("Already imported")
        } else {
            Button("Import") {
                Task { await doImport(name: name, source: source, isUpdate: false) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func emptyState(icon: String, title: String, subtitle: String) -> some View {
        VStack(spacing: 8) {
            Spacer()
            Image(systemName: icon)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text(subtitle).font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(20)
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        error = nil
        do {
            async let i = try api.listClaudeInstalled()
            async let m = try api.listClaudeMarketplace()
            let (iResp, mResp) = try await (i, m)
            installedPlugins = iResp.plugins
            marketplacePlugins = mResp.plugins
        } catch {
            self.error = "Could not scan Claude plugins: \(error.localizedDescription)"
        }
        loading = false
    }

    private func doImport(name: String, source: String, isUpdate: Bool) async {
        importingName = name
        importMessage = nil
        do {
            let resp = try await api.importClaudePlugin(name: name, source: source)
            if resp.ok, let p = resp.plugin {
                let verb = isUpdate ? "Updated" : "Imported"
                importMessage = "\(verb) \(p.displayName) (\(p.skillCount) skill\(p.skillCount == 1 ? "" : "s"), \(p.commandCount) cmd\(p.commandCount == 1 ? "" : "s"))"
                if let idx = installedPlugins.firstIndex(where: { $0.name == name }) {
                    installedPlugins[idx].alreadyImported = true
                }
                if let idx = marketplacePlugins.firstIndex(where: { $0.name == name }) {
                    marketplacePlugins[idx].alreadyImported = true
                }
                onImported()
                // Refresh the list so version info updates
                if isUpdate { await load() }
            } else {
                importMessage = resp.error ?? "Import failed"
            }
        } catch {
            importMessage = "Import failed: \(error.localizedDescription)"
        }
        importingName = nil
        let msg = importMessage
        Task {
            try? await Task.sleep(for: .seconds(4))
            if importMessage == msg { importMessage = nil }
        }
    }
}
