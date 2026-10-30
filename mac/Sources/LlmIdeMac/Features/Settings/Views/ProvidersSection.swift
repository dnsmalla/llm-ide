import SwiftUI

/// Settings → Providers: every model connection in one list, each shown once (the catalog's connections, the
/// custom providers and the built-in keys, see `ProviderRowBuilder`). It talks only to the API client and the
/// Mac's own provider list through `ProvidersModel`; which store an edit lands in is the model's job.
struct ProvidersSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(BackendManager.self) private var backend
    @ObservedObject var model: ProvidersModel
    let api: LlmIdeAPIClient

    @State private var showAdd = false
    @State private var editing: CustomProvider?
    @State private var pendingRemove: ProviderRow?
    @State private var showDiscardConfirm = false
    /// Model ids shown in full per connection id (the rest are collapsed past `modelPreviewLimit`).
    @State private var expandedModels: Set<String> = []

    /// Rows come from the model, which hides the Jev row against a server without decisions (API v73).
    private var rows: [ProviderRow] {
        model.rows.filter { $0.builtInId != ProviderCatalog.jevId || TierRouting.serverSupportsDecisions(backend.serverApiVersion) }
    }

    var body: some View {
        SettingsSectionCard(icon: "key.horizontal", title: ProvidersText.title) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint(ProvidersText.intro)

                migrationNotes

                if let loadError = model.catalog.loadError {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Couldn't load the catalog: \(loadError). Entries stored on this Mac are shown below; one that is also connected in the catalog may appear twice until it loads.")
                            .font(Typography.caption).foregroundStyle(theme.current.danger)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Retry") { Task { await model.load() } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                } else if model.catalog.isLoading && !model.catalog.hasLoaded {
                    ProgressView().controlSize(.small)
                }

                if model.isListUnreadable {
                    Text("The custom provider list is unreadable (a backup was kept). Adding, editing and deleting custom providers is off so the stored list is not overwritten.")
                        .font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Discard unreadable list (backup kept)", role: .destructive) { showDiscardConfirm = true }
                        .buttonStyle(.bordered).controlSize(.small)
                }

                ForEach(rows) { row in
                    ProviderRowView(row: row, model: model, expandedModels: $expandedModels,
                                    onEdit: { editing = $0 }, onRemove: { pendingRemove = $0 })
                    Divider()
                }

                if let error = model.actionError ?? model.catalog.actionError {
                    Text(error).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button { showAdd = true } label: { Label("Add provider", systemImage: "plus") }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(model.isListUnreadable && !model.catalog.hasLoaded)
                    .accessibilityLabel("Add a provider")
            }
        }
        .task {
            await backend.refreshServerApiVersion()
            model.cliReady = ProviderCliCheckCache.results
            await model.load()
            await refreshLiveModels()
        }
        .onChange(of: config.activeCLI) { _, _ in Task { await refreshLiveModels() } }
        .onReceive(NotificationCenter.default.publisher(for: .customProvidersChanged)) { _ in model.refreshCustom() }
        .sheet(isPresented: $showAdd) {
            AddProviderSheet(model: model) { showAdd = false }
        }
        .sheet(item: $editing) { provider in
            CustomProviderForm(model: model, provider: provider) { editing = nil }
        }
        .confirmationDialog(
            pendingRemove.map { "Remove \($0.name)?" } ?? "Remove provider?",
            isPresented: Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let row = pendingRemove { Task { await model.remove(row) } }
                pendingRemove = nil
            }
            Button("Cancel", role: .cancel) { pendingRemove = nil }
        } message: {
            Text("Its stored API key is removed too. Other entries are not affected.")
        }
        .confirmationDialog("Discard the unreadable provider list?", isPresented: $showDiscardConfirm,
                            titleVisibility: .visible) {
            Button("Discard (backup kept)", role: .destructive) { model.discardUnreadableList() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A copy is saved first. Your custom providers will need to be re-added from that backup.")
        }
    }

    /// The upgrade path: keys carried over into the catalog (never deleted from where they were), a key that
    /// could not be, and the session router that chat on a catalog model needs.
    @ViewBuilder private var migrationNotes: some View {
        if let m = model.catalog.migration, !(m.created.isEmpty && m.needsReview.isEmpty) {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                if !m.created.isEmpty {
                    Text(ProviderMigrationText.createdLine(m.created.map(\.name)))
                        .font(Typography.caption).foregroundStyle(theme.current.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(m.needsReview, id: \.provider) { r in
                    Text(ProviderMigrationText.reviewLine(name: r.name, reason: r.reason))
                        .font(Typography.caption).foregroundStyle(theme.current.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, Spacing.xs)
        }
    }

    /// The default provider's live model list, so the Model routing pickers offer everything the account can use.
    private func refreshLiveModels() async {
        guard let tool = AICliTool(rawValue: config.activeCLI),
              let models = try? await api.listProviderModels(tool.provider), !models.isEmpty else { return }
        LiveModelCache.store(models, for: tool.provider)
    }
}

// MARK: - One row

private struct ProviderRowView: View {
    let row: ProviderRow
    @ObservedObject var model: ProvidersModel
    @Binding var expandedModels: Set<String>
    let onEdit: (CustomProvider) -> Void
    let onRemove: (ProviderRow) -> Void

    @EnvironmentObject var theme: ThemeStore
    /// The key being typed. Cleared the moment it is sent, and when the row goes away; never echoed.
    @State private var keyDraft = ""
    @State private var urlDraft = ""
    @State private var showModels = false

    private var isBusy: Bool { model.busy.contains(row.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            header
            Text(row.detail)
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                .lineLimit(row.baseURL == nil ? 3 : 1).truncationMode(.middle)
            if row.alsoLegacyKey {
                Text("An older key for this provider is also stored. It is kept, not deleted.")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
            }
            if row.builtInId == "custom" { sharedURLField }
            keyLine
            actions
            if let message = model.messages[row.id] {
                Text(message.text)
                    .font(Typography.caption)
                    .foregroundStyle(message.ok ? theme.current.success : theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(row.name): \(message.text)")
            }
            if showModels { modelsList }
        }
        .padding(.vertical, 4)
        .opacity(row.enabled ? 1 : 0.6)
        .onDisappear { keyDraft = "" }
        .onAppear { urlDraft = row.baseURL ?? "" }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Spacing.sm) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.sm) { title; typeBadge; statusBadge }
                VStack(alignment: .leading, spacing: 4) {
                    title
                    HStack(spacing: Spacing.sm) { typeBadge; statusBadge }
                }
            }
            Spacer(minLength: 0)
            if isBusy { ProgressView().controlSize(.small) }
            if row.canToggle {
                Toggle("Enabled", isOn: Binding(get: { row.enabled }, set: { _ in Task { await model.toggleEnabled(row) } }))
                    .toggleStyle(.switch).controlSize(.small).labelsHidden()
                    .disabled(isBusy)
                    .accessibilityLabel("\(row.name) enabled")
                    .help(row.enabled ? "Switch this provider off without removing it" : "Switch this provider on")
            }
        }
    }

    private var title: some View {
        Text(row.name).font(Typography.bodyStrong).lineLimit(1).truncationMode(.tail)
    }

    private var typeBadge: some View {
        badge(row.kind.label, color: theme.current.textMuted)
            .accessibilityLabel("Type: \(row.kind.label)")
    }

    @ViewBuilder private var statusBadge: some View {
        switch row.keyStatus {
        case .stored:
            badge("Key stored", color: theme.current.success, icon: "checkmark").accessibilityLabel("API key stored")
        case .missing:
            badge("Key missing", color: theme.current.warning).accessibilityLabel("API key missing")
        case .notNeeded:
            badge("No key needed", color: theme.current.textMuted).accessibilityLabel("No API key needed")
        case .unknown:
            EmptyView()
        }
        if !row.enabled { badge("Off", color: theme.current.textMuted).accessibilityLabel("Switched off") }
    }

    private func badge(_ text: String, color: Color, icon: String? = nil) -> some View {
        HStack(spacing: 3) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .bold)).accessibilityHidden(true) }
            Text(text).font(Typography.caption).lineLimit(1)
        }
        .padding(.horizontal, 6).padding(.vertical, 1)
        .background(Capsule().fill(color.opacity(0.15)))
        .foregroundStyle(color)
        .fixedSize()
    }

    // MARK: Key and URL

    @ViewBuilder private var sharedURLField: some View {
        HStack(spacing: Spacing.sm) {
            TextField("Base URL, e.g. https://openrouter.ai/api/v1", text: $urlDraft)
                .textFieldStyle(.roundedBorder).frame(maxWidth: 420)
                .accessibilityLabel("\(row.name) base URL")
            Button("Save URL") { Task { await model.saveSharedBaseURL(urlDraft, row: row) } }
                .controlSize(.small)
                .disabled(urlDraft.trimmingCharacters(in: .whitespaces).isEmpty || isBusy)
        }
    }

    private var keyLine: some View {
        HStack(spacing: Spacing.sm) {
            SecureField(row.keyStatus == .stored ? "Enter a new key to replace the stored one" : "API key",
                        text: $keyDraft)
                .textFieldStyle(.roundedBorder).frame(maxWidth: 340)
                .accessibilityLabel("API key for \(row.name)")
            Button(row.isCatalog || row.isCustom ? "Save key" : "Save & verify") {
                let key = keyDraft
                keyDraft = ""   // gone from view state before the request leaves
                Task { _ = await model.setKey(row, key: key) }
            }
            .controlSize(.small)
            .disabled(keyDraft.trimmingCharacters(in: .whitespaces).isEmpty || isBusy)
            .accessibilityLabel("Save key for \(row.name)")
        }
    }

    // MARK: Actions

    private var actions: some View {
        HStack(spacing: Spacing.sm) {
            Button("Test") { Task { await model.test(row, typedKey: keyDraft) } }
                .disabled(isBusy || !canTest)
                .accessibilityLabel("Test \(row.name)")
            if hasCliCheck {
                Button("Check CLI") { Task { await model.test(row, cli: true) } }
                    .disabled(isBusy)
                    .help("Confirm this provider's CLI is installed; your CLI login (subscription) is used when it runs, no key needed")
                    .accessibilityLabel("Check the CLI for \(row.name)")
            }
            if row.isCatalog || (row.isCustom && !(model.customProvider(for: row)?.models.isEmpty ?? true)) {
                Button(showModels ? "Hide models" : "Models") { toggleModels() }
                    .accessibilityLabel("\(showModels ? "Hide" : "Show") models of \(row.name)")
            }
            if row.canEditDetails, let cp = model.customProvider(for: row) {
                Button("Edit") { onEdit(cp) }
                    .disabled(model.isListUnreadable)
                    .accessibilityLabel("Edit \(row.name)")
            }
            if row.moveSource != nil {
                Button("Move to catalog") { Task { await model.moveToCatalog(row) } }
                    .disabled(isBusy)
                    .help("Copy this entry into the catalog. The key is copied on the server; the old entry is kept.")
                    .accessibilityLabel("Move \(row.name) to the catalog")
            }
            if row.canClearKey {
                Button("Clear key") { Task { await model.clearKey(row) } }
                    .disabled(isBusy)
                    .accessibilityLabel("Clear the key for \(row.name)")
            }
            Spacer(minLength: 0)
            if row.canRemove {
                Button("Remove", role: .destructive) { onRemove(row) }
                    .disabled(isBusy || (row.isCustom && model.isListUnreadable))
                    .accessibilityLabel("Remove \(row.name)")
            }
        }
        .buttonStyle(.bordered).controlSize(.small)
    }

    /// A built-in row is tested with its stored key (Anthropic may have none: it also runs on the CLI login),
    /// so without a key there is nothing to test. Catalog and custom rows can always be probed.
    private var canTest: Bool {
        guard let id = row.builtInId else { return true }
        return row.keyStatus == .stored || id == ClaudeCLI.provider
    }

    private var hasCliCheck: Bool {
        guard let id = row.builtInId, let tool = ProviderCatalog.all.first(where: { $0.id == id })?.tool else { return false }
        return !tool.cliExecutable.isEmpty
    }

    private func toggleModels() {
        showModels.toggle()
        if showModels, let c = model.connection(for: row) { Task { await model.catalog.loadModels(c) } }
    }

    // MARK: Models

    @ViewBuilder private var modelsList: some View {
        if let c = model.connection(for: row) {
            if let list = model.catalog.modelLists[c.id] {
                let shown = ProviderRowBuilder.visibleModels(list.models, showAll: expandedModels.contains(c.id))
                VStack(alignment: .leading, spacing: 2) {
                    if list.source == "static" {
                        SettingsHint("Showing the catalog's own list\(list.detail.map { ": \($0)" } ?? ".")")
                    } else if let detail = list.detail {
                        SettingsHint("Showing the last list: \(detail)")
                    }
                    ForEach(shown) { m in modelRow(m, connection: c) }
                    if shown.count < list.models.count {
                        Button("Show all \(list.models.count) models") { expandedModels.insert(c.id) }
                            .buttonStyle(.borderless).controlSize(.small)
                    }
                }
                .padding(.leading, Spacing.md)
            } else {
                ProgressView().controlSize(.small)
            }
        } else if let cp = model.customProvider(for: row) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(cp.models) { m in
                    Text(m.displayName).font(Typography.caption).foregroundStyle(theme.current.text)
                }
                SettingsHint("Models of a custom provider are the ones you listed when you added it. Edit it to change them.")
            }
            .padding(.leading, Spacing.md)
        }
    }

    private func modelRow(_ m: LlmIdeAPIClient.CatalogModel, connection c: LlmIdeAPIClient.CatalogConnection) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.xs) {
                Text(m.id).font(Typography.caption).foregroundStyle(theme.current.text)
                    .lineLimit(1).truncationMode(.middle)
                if let b = ProviderCatalogRules.toolsBadge(m) { badge(b, color: theme.current.success) }
                if let ctx = ProviderCatalogRules.contextText(m) {
                    Text(ctx).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                }
                Spacer()
                Toggle("Has tools", isOn: Binding(
                    get: { m.toolsSupported },
                    set: { on in Task { await model.catalog.setToolOverride(c, model: m.id, to: on) } }))
                    .toggleStyle(.checkbox).controlSize(.small)
                    .help("Mark this model as able (or not) to call tools. Your choice overrides the catalog.")
                    .accessibilityLabel("\(m.id) has tools")
            }
            if let hint = ProviderCatalogRules.noToolsHint(m) {
                Text(hint).font(Typography.caption).foregroundStyle(theme.current.textMuted)
            }
        }
    }
}
