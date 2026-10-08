import SwiftUI
import os.log

private let tierRoutingSectionLogger = Logger(subsystem: "com.llmide.macapp", category: "TierRouting")

/// Settings card "Tiers & Roles": Standard (required, the default) plus
/// optional Strong / Cheap, each a provider + model; then the tier each role
/// uses, grouped Chat · Background · Server. Saving Standard writes it through
/// to the legacy default fields (`AppConfig.applyStandardTier`).
struct TierRoutingSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    /// The composer override Standard's write-through sets for a custom Standard.
    @AppStorage(TierDefaults.composerProviderKey) var composerProviderId = ""
    /// Standard first: it is the default and the only required tier.
    private static let tierOrder: [RoutingTier] = [.standard, .strong, .cheap]
    /// Read for `serverApiVersion` only — routing needs API v67+.
    @Environment(BackendManager.self) private var backend
    @State var routing = TierRoutingConfig.load()
    /// The server's view (version, per-tier status, dropped entries), as last
    /// fetched — mirrors `TierRoutingServerCache`, which the resolvers read.
    @State var serverState = TierRoutingServerCache.shared.state
    /// A provider picked for a tier whose model list is still empty (Claude's
    /// live list not loaded, a custom provider with no models): shown in the
    /// menu but NOT saved, so the table never stores `model: ""`. Saved once a
    /// model is chosen.
    @State private var pendingProviders: [String: String] = [:]
    @State var customProviders = CustomProvider.loadAll()
    @State private var syncError: String?
    /// Bumped when Claude's live model list lands, so the menus re-read it.
    @State private var modelsRevision = 0

    var body: some View {
        SettingsSectionCard(icon: "dial.medium", title: "Tiers & Roles") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Standard is the default: new chats and every role on this Mac left on Standard use it. Strong and Cheap are optional. Then choose the tier each role uses. A tier that can't be used is skipped silently, and its row says what runs instead.")

                if let versionNote = serverVersionNote {
                    Text(versionNote)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("Tiers")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(theme.current.text)
                ForEach(Self.tierOrder) { tier in
                    tierRow(tier)
                }

                Divider().padding(.vertical, Spacing.xs)

                ForEach(RoutedFeatureGroup.allCases, id: \.self) { group in
                    Text(group.title)
                        .font(Typography.body.weight(.semibold))
                        .foregroundStyle(theme.current.text)
                        .padding(.top, Spacing.xs)
                    if group == .chat {
                        // WARNING: a model change rewrites the prompt cache, like a mode change.
                        note("Switching to a mode with a different model re-reads the conversation once, so use one tier for modes you switch between often. A model picked in the chat composer overrides these for that chat.")
                    }
                    ForEach(RoutedFeature.allCases.filter { $0.group == group }) { feature in
                        featureRow(feature)
                    }
                }

                if !serverState.dropped.isEmpty {
                    note("The server ignored: "
                         + serverState.dropped.map { "\($0.entry) (\($0.reason))" }.joined(separator: ", "))
                }

                if let syncError {
                    Text(syncError)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .id(modelsRevision)
        }
        .onReceive(NotificationCenter.default.publisher(for: .customProvidersChanged)) { _ in
            customProviders = CustomProvider.loadAll()
            sync()   // the server's per-tier status depends on custom providers
        }
        // Every refresh (this card's or the app's, e.g. on a server version
        // change) lands here, so the notes follow the resolvers' cache.
        .onReceive(NotificationCenter.default.publisher(for: .tierRoutingServerStateChanged)) { _ in
            serverState = TierRoutingServerCache.shared.state
            // A later successful refresh (possibly app-level) supersedes an
            // earlier failure this card showed.
            if serverState.status != nil { syncError = nil }
        }
        .task {
            routing = TierRoutingConfig.load()
            customProviders = CustomProvider.loadAll()
            // The version gates everything below; probe rather than trust a
            // cache that may predate a server restart (a change also triggers
            // the app-level refresh; the shared refresh path coalesces them).
            await backend.refreshServerApiVersion()
            sync()   // the server's copy is per user; re-push like custom providers
            await loadLiveModels(for: ClaudeCLI.provider)
        }
    }

    // MARK: - Rows

    private func tierRow(_ tier: RoutingTier) -> some View {
        let route = routing.tier(tier)
        let shownProvider = pendingProviders[tier.rawValue] ?? route?.provider
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spacing.sm) {
                HStack(spacing: 4) {
                    Text(tier.displayName)
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                    if tier == .standard {
                        Text("Default")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(theme.current.accent)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(theme.current.accent.opacity(0.12)).clipShape(Capsule())
                            .help("New chats and every role on this Mac left on Standard use this tier")
                    }
                }
                .frame(width: 130, alignment: .leading)
                Picker("Provider", selection: providerBinding(tier)) {
                    // Standard is required: once set it has no "unset" entry.
                    if tier != .standard || shownProvider == nil {
                        Text(tier == .standard ? "Choose…" : "Not set").tag("")
                    }
                    ForEach(TierRouting.builtInProviders, id: \.wireId) { entry in
                        Text(entry.tool.displayName).tag(entry.wireId)
                    }
                    ForEach(customProviders.filter(\.isEnabled)) { provider in
                        Text(provider.name).tag(provider.wireId)
                    }
                    // A deleted/disabled provider still stored here keeps a tag,
                    // so the menu names what is saved instead of going blank.
                    if let route, !isListedProvider(route.provider) {
                        Text("\(route.provider) (unavailable)").tag(route.provider)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: 180)
                if let shownProvider {
                    Picker("Model", selection: modelBinding(tier)) {
                        // A pending provider has no saved model: a placeholder
                        // tag keeps the selection matching a row.
                        if pendingProviders[tier.rawValue] != nil {
                            Text(models(forProvider: shownProvider).isEmpty ? "No models available" : "Choose a model")
                                .tag("")
                        }
                        ForEach(modelChoices(provider: shownProvider, saved: pendingProviders[tier.rawValue] == nil ? route?.model : nil),
                                id: \.id) { model in
                            Text(model.displayName).tag(model.id)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
                Spacer()
            }
            if tier == .standard {
                standardNotes(route)
            } else if let route, let reason = TierRouting.unusableReason(route, customProviders: customProviders) {
                note("roles on \(tier.displayName) use their unset choice — \(reason)")
            } else if let route, TierDefaults.isMacOnlyProvider(route.provider) {
                note("roles on \(tier.displayName) other than chat modes use their unset choice — "
                     + TierDefaults.macOnlyProviderNote)
            } else if let route, serverSupported, let status = serverState.status?[tier.rawValue] {
                if !status.usable {
                    note("server roles on \(tier.displayName) use their built-in default — the server can't run it: \(TierRouting.describeServerReason(status.reason))")
                } else if let via = TierRouting.describeVia(status.via, provider: route.provider) {
                    note(via)
                }
            }
            if pendingProviders[tier.rawValue] != nil {
                note(route.map { "not saved until a model is chosen — still using \($0.provider) · \($0.model)" }
                     ?? "not saved until a model is chosen")
            }
        }
    }

    /// Standard's warnings: unset, unusable (keeps the last default), not yet
    /// applied (a Standard from before this update), and the Agent-engine note.
    @ViewBuilder
    private func standardNotes(_ route: TierRoute?) -> some View {
        let summaries = customProviders.map(TierCustomProviderSummary.init)
        let current = TierDefaults.describeCurrentDefault(
            activeCLI: config.activeCLI, defaultModelId: config.defaultModelId,
            composerProviderId: composerProviderId, customProviders: summaries, standard: route)
        let reason = route.flatMap { TierRouting.unusableReason($0, customProviders: customProviders) }
        if let warning = TierDefaults.standardWarning(isSet: route != nil, unusableReason: reason, currentDefault: current) {
            Text(warning)
                .font(Typography.caption)
                .foregroundStyle(theme.current.warning)
                .fixedSize(horizontal: false, vertical: true)
        } else if let route {
            if !TierDefaults.isApplied(route, activeCLI: config.activeCLI, defaultModelId: config.defaultModelId,
                                       composerProviderId: composerProviderId, customProviders: summaries) {
                if let customId = TierRouting.customProviderId(route.provider), customId == composerProviderId {
                    // Already written through; the provider no longer lists the model.
                    note("New chats start on \(current) — the provider doesn't list \(route.model).")
                } else {
                    HStack(spacing: Spacing.sm) {
                        note("New chats and Mac roles left on Standard still use \(current).")
                        Button("Make Standard the default") { config.applyStandardTier(route) }
                            .controlSize(.small)
                    }
                }
            }
            if TierRouting.unusableReason(route, customProviders: customProviders, requiresAgentEngine: true) != nil {
                note(TierDefaults.standardAgentEngineNote)
            }
            if TierDefaults.isMacOnlyProvider(route.provider) {
                note("server roles on Standard use their built-in default — " + TierDefaults.macOnlyProviderNote)
            } else if serverSupported, let status = serverState.status?[RoutingTier.standard.rawValue] {
                if !status.usable {
                    note("server roles on Standard use their built-in default — the server can't run it: \(TierRouting.describeServerReason(status.reason))")
                } else if let via = TierRouting.describeVia(status.via, provider: route.provider) {
                    note(via)
                }
            }
        }
    }

    var serverSupported: Bool { TierRouting.serverSupportsRouting(serverState.apiVersion) }

    /// Shown when nothing can route because of the server's version.
    private var serverVersionNote: String? {
        let version = backend.serverApiVersion ?? serverState.apiVersion
        guard !TierRouting.serverSupportsRouting(version) else { return nil }
        let required = TierRouting.requiredServerApiVersion
        guard let version else {
            return "Tier routing needs the LLM-IDE server's API v\(required) or newer, and no running server has "
                + "reported its version. Every role uses its default until it does."
        }
        return "Tier routing needs the LLM-IDE server's API v\(required) or newer; the running server is v\(version). "
            + "Every role uses its default until the server is restarted on a newer version."
    }

    func note(_ text: String) -> some View {
        Text(text)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Derived state

    private func isListedProvider(_ provider: String) -> Bool {
        TierRouting.builtInProviders.contains { $0.wireId == provider }
            || customProviders.contains { $0.isEnabled && $0.wireId == provider }
    }

    private func models(forProvider provider: String) -> [AIModel] {
        if let customId = TierRouting.customProviderId(provider) {
            return customProviders.first { $0.id == customId }?.models ?? []
        }
        return TierRouting.builtInProviders.first { $0.wireId == provider }?.tool.pickerModels ?? []
    }

    /// The provider's models, plus the saved model when the list lacks it (a
    /// live list not fetched yet), so the menu never shows a blank selection.
    private func modelChoices(provider: String, saved: String?) -> [AIModel] {
        let list = models(forProvider: provider)
        guard let saved, !saved.isEmpty, !list.contains(where: { $0.id == saved }) else { return list }
        return list + [AIModel(id: saved, displayName: saved)]
    }

    // MARK: - Bindings

    private func providerBinding(_ tier: RoutingTier) -> Binding<String> {
        Binding(
            get: { pendingProviders[tier.rawValue] ?? routing.tier(tier)?.provider ?? "" },
            set: { provider in
                var updated = routing
                if provider.isEmpty {
                    // Standard is required; its menu offers no unset entry once set.
                    guard tier != .standard else { return }
                    pendingProviders[tier.rawValue] = nil
                    updated.tiers[tier.rawValue] = nil
                } else if updated.tiers[tier.rawValue]?.provider == provider {
                    pendingProviders[tier.rawValue] = nil   // back to what is saved
                } else if let first = models(forProvider: provider).first?.id {
                    // A new provider starts on its first model; the old model
                    // id belongs to the previous provider.
                    pendingProviders[tier.rawValue] = nil
                    updated.tiers[tier.rawValue] = TierRoute(provider: provider, model: first)
                } else {
                    // No model to start on: never store `model: ""`. Keep what
                    // is saved (or unset) until a model is chosen.
                    pendingProviders[tier.rawValue] = provider
                    // E.g. the shared Custom endpoint: its list is only known
                    // once read from the endpoint.
                    if TierRouting.customProviderId(provider) == nil { Task { await loadLiveModels(for: provider) } }
                    return
                }
                apply(updated)
            }
        )
    }

    private func modelBinding(_ tier: RoutingTier) -> Binding<String> {
        Binding(
            get: { pendingProviders[tier.rawValue] != nil ? "" : (routing.tier(tier)?.model ?? "") },
            set: { model in
                guard !model.isEmpty,
                      let provider = pendingProviders[tier.rawValue] ?? routing.tier(tier)?.provider else { return }
                pendingProviders[tier.rawValue] = nil
                var updated = routing
                updated.tiers[tier.rawValue] = TierRoute(provider: provider, model: model)
                apply(updated)
            }
        )
    }

    // MARK: - Persistence + sync

    func apply(_ updated: TierRoutingConfig) {
        guard updated != routing else { return }
        let standardChanged = updated.tier(.standard) != routing.tier(.standard)
        routing = updated
        if updated.save() {
            // Written through only once saved, so a failed save never leaves
            // activeCLI ahead of the table.
            if standardChanged, let standard = updated.tier(.standard) {
                config.applyStandardTier(standard)
            }
            sync(pushing: updated)
        } else {
            syncError = "Couldn't save the routing table."
        }
    }

    /// Push + status fetch through the app's single refresh path
    /// (`TierRoutingRefresh`); the failure is shown, not swallowed, because an
    /// unsynced table silently leaves every role on its default. Below API v67
    /// nothing routes — the version note says why.
    ///
    /// - Parameter table: an edit's new table; nil (appear, provider change)
    ///   pushes the STORED one, which is skipped when it is unreadable so the
    ///   server's copy is not wiped by an empty stand-in.
    private func sync(pushing table: TierRoutingConfig? = nil) {
        Task {
            switch await TierRoutingRefresh.request(api: api, serverApiVersion: { backend.serverApiVersion },
                                                    config: table) {
            case .updated:
                syncError = nil
            case .failed(let error):
                tierRoutingSectionLogger.error("Tier routing sync failed: \(error.localizedDescription, privacy: .public)")
                syncError = "Couldn't sync tier routing to the server: \(error.localizedDescription). Every role uses its default until it succeeds."
            case .superseded:
                break   // a newer refresh owns the outcome
            }
            serverState = TierRoutingServerCache.shared.state
        }
    }

    /// A built-in provider's live model list (Claude's, the shared Custom
    /// endpoint's) lives only in `LiveModelCache`; without this its model menu
    /// is empty until the Code Assistant panel has fetched it.
    private func loadLiveModels(for provider: String) async {
        guard LiveModelCache.models(for: provider) == nil else { return }
        guard let models = try? await api.listProviderModels(provider), !models.isEmpty else { return }
        LiveModelCache.store(models, for: provider)
        modelsRevision += 1
    }
}
