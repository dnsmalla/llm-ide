import SwiftUI

/// Words the Model routing section uses, in one place so a test can pin them.
enum ModelRoutingText {
    static let title = "Model routing"
    static let intro = "Which model each job uses: Standard is the default for new chats and every role left on it; Strong and Cheap are optional; Image is for image generation only. A tier that can't be used is skipped, and its row says what runs instead."
    static let switchesTitle = "Fallback and limits"
    static let tools = "Lets a model with the tools badge read files, search and run commands in a chat turn, under the same approvals as Claude; off, these providers answer without tools."
    static let egress = "Off by default: fetch-url and web-search ask first on these providers, because a hostile page can steer a model into sending what it has read."
    static let fallback = "Off by default: when a provider is rate-limited, try the next one in your list before a turn starts, and say so in the chat."
    static let router = "Off by default: adds a per-chat control to pin a provider and model and set a token limit; applies the next time the backend starts."
    static let cap = "Counts input, output and cache-write tokens and stops a chat at its limit with a one-click raise; applies the next time the backend starts."
    static let noConnections = "Connect a provider in Providers to use these switches."
}

/// The router / token-cap / tools switches and the fallback order. They moved here from the Provider catalog
/// card: they decide how models are chosen, not which providers exist. Writes go through the shared
/// `ProviderCatalogModel` (the server copy of the settings); the two router switches are session prefs read
/// when the backend next starts, so a change applies then (a restart would end a running turn).
struct ModelRoutingSwitches: View {
    @ObservedObject var catalog: ProviderCatalogModel
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @AppStorage(ChatRoutePreference.routerKey) private var routerOn = false
    @AppStorage(ChatRoutePreference.capKey) private var routerCapOn = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text(ModelRoutingText.switchesTitle)
                .font(Typography.body.weight(.semibold)).foregroundStyle(theme.current.text)

            if let loadError = catalog.loadError {
                HStack(alignment: .firstTextBaseline) {
                    Text("Couldn't load the provider settings: \(loadError)")
                        .font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Retry") { Task { await catalog.load() } }.buttonStyle(.bordered).controlSize(.small)
                }
            }

            // The upgrade path after the one-time key carry-over: tools and the router stay off until chosen.
            if let m = catalog.migration, !m.created.isEmpty {
                if m.toolsSuggested && !catalog.settings.toolsEnabled {
                    SettingsHint(ProviderMigrationText.toolsExplanation)
                }
                if !routerOn {
                    HStack(alignment: .firstTextBaseline) {
                        SettingsHint(ProviderMigrationText.routerNeeded)
                        Spacer()
                        Button("Turn on the session router") { routerOn = true }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                    }
                } else {
                    SettingsHint(ProviderMigrationText.routerPending)
                }
            }

            if catalog.hasLoaded {
                if catalog.connections.isEmpty {
                    SettingsHint(ModelRoutingText.noConnections)
                } else {
                    toggle("Allow tools on provider models", on: catalog.settings.toolsEnabled,
                           explanation: ModelRoutingText.tools) { $0.toolsEnabled = $1 }
                    toggle("Let these models fetch URLs and search the web without asking",
                           on: catalog.settings.egressAutoApprove,
                           explanation: ModelRoutingText.egress) { $0.egressAutoApprove = $1 }
                    toggle("Fall back to the next provider when one is rate-limited",
                           on: catalog.settings.fallbackEnabled,
                           explanation: ModelRoutingText.fallback) { $0.fallbackEnabled = $1 }
                    if catalog.settings.fallbackEnabled { fallbackOrderEditor }
                }
            }

            // Session router prefs: independent of the catalog, so they stay available while it loads.
            Toggle("Per-chat model and token limit (beta)", isOn: $routerOn)
            SettingsHint(ModelRoutingText.router)
            if routerOn {
                Toggle("Enforce the token limit", isOn: $routerCapOn)
                SettingsHint(ModelRoutingText.cap)
            }

            if let error = catalog.actionError {
                Text(error).font(Typography.caption).foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { if !catalog.hasLoaded { await catalog.load() } }
    }

    private func toggle(_ title: String, on: Bool, explanation: String,
                        set: @escaping (inout LlmIdeAPIClient.CatalogSettings, Bool) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle(title, isOn: Binding(get: { on }, set: { value in
                Task {
                    await catalog.update { set(&$0, value) }
                    // The composer menu and the engine-selection rule read the published index.
                    await api.refreshCatalogConnectionIndex()
                }
            }))
            SettingsHint(explanation)
        }
    }

    private var fallbackOrderEditor: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Fallback order").font(Typography.body).foregroundStyle(theme.current.text)
            ForEach(catalog.connections) { c in
                Toggle(c.name, isOn: Binding(
                    get: { catalog.inFallback(c) },
                    set: { on in Task { await catalog.setInFallback(c, on) } }))
                    .toggleStyle(.checkbox).controlSize(.small)
            }
            ForEach(Array(catalog.settings.fallbackOrder.enumerated()), id: \.element) { i, entry in
                HStack {
                    Text("\(i + 1).").font(Typography.caption).foregroundStyle(theme.current.textMuted).monospacedDigit()
                    Text(catalog.name(forProvider: entry.provider)).font(Typography.body)
                    Spacer()
                    Button { Task { await catalog.move(entry, by: -1) } } label: { Image(systemName: "arrow.up") }
                        .disabled(i == 0).accessibilityLabel("Move \(catalog.name(forProvider: entry.provider)) up")
                    Button { Task { await catalog.move(entry, by: 1) } } label: { Image(systemName: "arrow.down") }
                        .disabled(i == catalog.settings.fallbackOrder.count - 1)
                        .accessibilityLabel("Move \(catalog.name(forProvider: entry.provider)) down")
                }
                .buttonStyle(.borderless)
            }
        }
    }
}
