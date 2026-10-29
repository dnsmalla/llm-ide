import SwiftUI

/// Settings → Provider catalog: connect OpenAI, Google, Mistral, Groq, DeepSeek,
/// OpenRouter, xAI, Cerebras, Together, a local Ollama or any OpenAI-compatible
/// endpoint; paste a key (it goes to the server's vault and is not kept here);
/// test the connection; see each model with a "tools" badge; and, only if the
/// user turns them on, tool-capable chat on these providers and an ordered
/// fallback list. Registered in the `providerCatalog` Settings slot by Shell
/// (`FeatureCatalog.registerSettingsSections`); it talks only to the API client.
struct ProviderCatalogSettingsCard: View {
    @EnvironmentObject var theme: ThemeStore
    @StateObject private var model: ProviderCatalogModel
    @State private var connecting: LlmIdeAPIClient.CatalogProvider?
    @State private var expandedModels: Set<String> = []

    init(api: LlmIdeAPIClient) {
        _model = StateObject(wrappedValue: ProviderCatalogModel(api: api))
    }

    var body: some View {
        SettingsSectionCard(icon: "square.stack.3d.up", title: "Provider catalog") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Connect more model providers. Keys are stored encrypted on this machine's backend, per user, and are never shown again. A connected provider's models appear below with a tools badge; chat and the Loop only use tools on a model that has one.")

                if let loadError = model.loadError {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Couldn't load the catalog: \(loadError)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.danger)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Retry") { Task { await model.load() } }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                } else if model.isLoading && model.providers.isEmpty {
                    ProgressView().controlSize(.small)
                }

                ForEach(model.providers) { entry in
                    entryRow(entry)
                    Divider()
                }

                if let actionError = model.actionError {
                    Text(actionError)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !model.providers.isEmpty { switchesSection }
            }
        }
        .task { await model.load() }
        .sheet(item: $connecting) { entry in
            ConnectCatalogProviderSheet(entry: entry, model: model) { connecting = nil }
        }
    }

    // MARK: - Provider rows

    private func entryRow(_ entry: LlmIdeAPIClient.CatalogProvider) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(entry.name).font(Typography.body).foregroundStyle(theme.current.text)
                if entry.local { badge("local", color: theme.current.textMuted) }
                Spacer()
                Button(entry.connections.isEmpty ? "Connect" : (entry.customBaseURL ? "Add another" : "Update key")) {
                    connecting = entry
                }
                .buttonStyle(.bordered).controlSize(.small)
                .accessibilityLabel("\(entry.connections.isEmpty ? "Connect" : "Update") \(entry.name)")
            }
            if !entry.notes.isEmpty { SettingsHint(entry.notes) }
            ForEach(entry.connections) { connection in connectionRow(connection) }
        }
    }

    private func connectionRow(_ c: LlmIdeAPIClient.CatalogConnection) -> some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: c.hasKey ? "checkmark.circle.fill" : "exclamationmark.circle")
                    .foregroundStyle(c.hasKey ? theme.current.success : theme.current.warning)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(c.name).font(Typography.body).foregroundStyle(theme.current.text)
                    Text(c.baseURL).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                if model.busy.contains(c.id) { ProgressView().controlSize(.small) }
                Button("Test") { Task { await model.test(c) } }
                    .buttonStyle(.bordered).controlSize(.small)
                Button(expandedModels.contains(c.id) ? "Hide models" : "Models") {
                    if expandedModels.contains(c.id) { expandedModels.remove(c.id) } else {
                        expandedModels.insert(c.id)
                        Task { await model.loadModels(c) }
                    }
                }
                .buttonStyle(.bordered).controlSize(.small)
                Button("Disconnect", role: .destructive) { Task { await model.disconnect(c) } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
            if let r = model.testResults[c.id] {
                Text(r.text)
                    .font(Typography.caption)
                    .foregroundStyle(r.ok ? theme.current.success : theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if expandedModels.contains(c.id) { modelsList(c) }
        }
        .padding(.leading, Spacing.md)
    }

    @ViewBuilder
    private func modelsList(_ c: LlmIdeAPIClient.CatalogConnection) -> some View {
        if let list = model.modelLists[c.id] {
            VStack(alignment: .leading, spacing: 2) {
                if list.source == "static" {
                    SettingsHint("Showing the catalog's own list\(list.detail.map { ": \($0)" } ?? ".")")
                } else if let detail = list.detail {
                    SettingsHint("Showing the last list: \(detail)")
                }
                ForEach(list.models) { m in
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
                            set: { on in Task { await model.setToolOverride(c, model: m.id, to: on) } }))
                            .toggleStyle(.checkbox).controlSize(.small)
                            .help("Mark this model as able (or not) to call tools. Your choice overrides the catalog.")
                    }
                    if let hint = ProviderCatalogRules.noToolsHint(m) {
                        Text(hint).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    }
                }
            }
            .padding(.leading, Spacing.md)
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Typography.caption)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
            .fixedSize()
    }

    // MARK: - Switches and order

    private var switchesSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Toggle("Tool-capable chat on these providers (beta)", isOn: Binding(
                get: { model.settings.toolsEnabled },
                set: { on in Task { await model.update { $0.toolsEnabled = on } } }))
            SettingsHint("Off by default. When on, a model with the tools badge can read files, search, and run commands in a chat turn, behind the same approvals as Claude. Without it these providers answer without tools.")

            Toggle("Let these models fetch URLs and search the web without asking", isOn: Binding(
                get: { model.settings.egressAutoApprove },
                set: { on in Task { await model.update { $0.egressAutoApprove = on } } }))
            SettingsHint("Off by default: fetch-url and web-search ask first on these providers, because a hostile page can steer a model into sending what it has read to a web address.")

            Toggle("Fall back to the next provider when one is rate-limited", isOn: Binding(
                get: { model.settings.fallbackEnabled },
                set: { on in Task { await model.update { $0.fallbackEnabled = on } } }))
            SettingsHint("Off by default. Checked once, before a turn starts, and always reported in the chat; a turn never changes model while it runs. This only tries your list in your order. Stacking several free tiers can break a provider's terms; check each provider's before you rely on it.")

            if model.settings.fallbackEnabled { fallbackOrderEditor }
        }
    }

    private var fallbackOrderEditor: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Fallback order").font(Typography.body).foregroundStyle(theme.current.text)
            ForEach(model.connections) { c in
                Toggle(c.name, isOn: Binding(
                    get: { model.inFallback(c) },
                    set: { on in Task { await model.setInFallback(c, on) } }))
                    .toggleStyle(.checkbox).controlSize(.small)
            }
            ForEach(Array(model.settings.fallbackOrder.enumerated()), id: \.element) { i, entry in
                HStack {
                    Text("\(i + 1).").font(Typography.caption).foregroundStyle(theme.current.textMuted).monospacedDigit()
                    Text(model.name(forProvider: entry.provider)).font(Typography.body)
                    Spacer()
                    Button { Task { await model.move(entry, by: -1) } } label: { Image(systemName: "arrow.up") }
                        .disabled(i == 0).accessibilityLabel("Move up")
                    Button { Task { await model.move(entry, by: 1) } } label: { Image(systemName: "arrow.down") }
                        .disabled(i == model.settings.fallbackOrder.count - 1).accessibilityLabel("Move down")
                }
                .buttonStyle(.borderless)
            }
        }
    }
}

/// The connect sheet: key (SecureField, cleared when the sheet goes), and a base
/// URL only for the entries that take one.
private struct ConnectCatalogProviderSheet: View {
    let entry: LlmIdeAPIClient.CatalogProvider
    @ObservedObject var model: ProviderCatalogModel
    let onClose: () -> Void
    @EnvironmentObject var theme: ThemeStore
    @State private var apiKey = ""
    @State private var baseURL = ""
    @State private var slug = ""
    @State private var allowPrivate = false
    @State private var saving = false

    private var needsURL: Bool { entry.customBaseURL }
    private var canSave: Bool {
        let keyOK = !entry.keyRequired || !apiKey.trimmingCharacters(in: .whitespaces).isEmpty || !entry.connections.isEmpty
        return keyOK && (!needsURL || !baseURL.trimmingCharacters(in: .whitespaces).isEmpty) && !saving
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Connect \(entry.name)").font(Typography.title).foregroundStyle(theme.current.text)
            if needsURL {
                TextField("Base URL (https://host/v1)", text: $baseURL).textFieldStyle(.roundedBorder)
                TextField("Short name (letters and digits, optional)", text: $slug).textFieldStyle(.roundedBorder)
                Toggle("This is on my own network (localhost or a private address)", isOn: $allowPrivate)
                    .toggleStyle(.checkbox)
                SettingsHint("Only turn this on for a server you run. Link-local and cloud-metadata addresses are always refused.")
            } else {
                Text(entry.baseURL).font(Typography.caption).foregroundStyle(theme.current.textMuted)
            }
            SecureField(entry.keyRequired ? "API key" : "API key (optional)", text: $apiKey)
                .textFieldStyle(.roundedBorder)
            if !entry.connections.isEmpty { SettingsHint("Leave the key blank to keep the stored one.") }
            if let error = model.actionError {
                Text(error).font(Typography.caption).foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { apiKey = ""; model.actionError = nil; onClose() }
                Button("Connect") {
                    saving = true
                    Task {
                        let ok = await model.connect(
                            catalogId: entry.id, apiKey: apiKey,
                            baseURL: needsURL ? baseURL : nil,
                            slug: needsURL && !slug.isEmpty ? slug : nil,
                            allowPrivate: needsURL ? allowPrivate : nil)
                        apiKey = ""
                        saving = false
                        if ok { onClose() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSave)
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 420)
        .onDisappear { apiKey = "" }
    }
}
