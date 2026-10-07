import SwiftUI
import os.log

private let tierRoutingSectionLogger = Logger(subsystem: "com.llmide.macapp", category: "TierRouting")

/// Settings card for tier routing: three tiers (provider + model each) and the
/// tier each role uses. Every row defaults to "Default", which is exactly the
/// behaviour before tier routing existed.
struct TierRoutingSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    /// Read for `serverApiVersion` only — routing needs API v67+.
    @Environment(BackendManager.self) private var backend
    @State private var routing = TierRoutingConfig.load()
    /// The server's view (version, per-tier status, dropped entries), as last
    /// fetched — mirrors `TierRoutingServerCache`, which the resolvers read.
    @State private var serverState = TierRoutingServerCache.shared.state
    /// A provider picked for a tier whose model list is still empty (Claude's
    /// live list not loaded, a custom provider with no models): shown in the
    /// menu but NOT saved, so the table never stores `model: ""`. Saved once a
    /// model is chosen.
    @State private var pendingProviders: [String: String] = [:]
    @State private var customProviders = CustomProvider.loadAll()
    @State private var syncError: String?
    /// Bumped when Claude's live model list lands, so the menus re-read it.
    @State private var modelsRevision = 0

    var body: some View {
        SettingsSectionCard(icon: "dial.medium", title: "Tier Routing") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Run each role on a cheaper or stronger model. Pick a provider and model per tier, then choose which tier each role uses. Anything left on Default — or a tier that can't be used — runs exactly as before.")

                if let versionNote = serverVersionNote {
                    Text(versionNote)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Text("Tiers")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(theme.current.text)
                ForEach(RoutingTier.allCases) { tier in
                    tierRow(tier)
                }

                Divider().padding(.vertical, Spacing.xs)

                Text("Use tier for")
                    .font(Typography.body.weight(.semibold))
                    .foregroundStyle(theme.current.text)
                ForEach(RoutedFeature.allCases) { feature in
                    featureRow(feature)
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
        }
        .task {
            routing = TierRoutingConfig.load()
            customProviders = CustomProvider.loadAll()
            // The version gates everything below; probe rather than trust a
            // cache that may predate a server restart (a change also triggers
            // the app-level refresh; the shared refresh path coalesces them).
            await backend.refreshServerApiVersion()
            sync()   // the server's copy is per user; re-push like custom providers
            await loadClaudeModels()
        }
    }

    // MARK: - Rows

    private func tierRow(_ tier: RoutingTier) -> some View {
        let route = routing.tier(tier)
        let shownProvider = pendingProviders[tier.rawValue] ?? route?.provider
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spacing.sm) {
                Text(tier.displayName)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                    .frame(width: 80, alignment: .leading)
                Picker("Provider", selection: providerBinding(tier)) {
                    Text("Default").tag("")
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
            if let route, let reason = TierRouting.unusableReason(route, customProviders: customProviders) {
                note("uses default — \(reason)")
            } else if route != nil, serverSupported,
                      let status = serverState.status?[tier.rawValue], !status.usable {
                note("uses default — the server can't run it: \(TierRouting.describeServerReason(status.reason))")
            }
            if pendingProviders[tier.rawValue] != nil {
                note(route.map { "not saved until a model is chosen — still using \($0.provider) · \($0.model)" }
                     ?? "not saved until a model is chosen")
            }
        }
    }

    private func featureRow(_ feature: RoutedFeature) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spacing.sm) {
                Text(feature.displayName)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Spacer()
                Picker("Tier", selection: featureBinding(feature)) {
                    Text("Default").tag("")
                    ForEach(RoutingTier.allCases) { tier in
                        Text(tier.displayName).tag(tier.rawValue)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: 140)
            }
            if let reason = featureUnusableReason(feature) {
                note("uses default — \(reason)")
            } else if feature == .loop, let reason = agentEngineReason(for: .loop) {
                // The replay takes the route; the agent steps (the bulk of a
                // Loop's cost) run on the Agent SDK and keep their default.
                note("agent steps use default — \(reason). Only Claude or a custom provider "
                     + "with an Anthropic-compatible URL can run them.")
            } else if feature == .quickChat, let reason = agentEngineReason(for: .quickChat) {
                // Classic-engine chats take the route; a chat stamped for the
                // Agent engine needs an Anthropic-compatible provider.
                note("on Agent-engine chats uses default — \(reason). Only Claude or a custom provider "
                     + "with an Anthropic-compatible URL can run them.")
            }
        }
    }

    /// Why `feature`'s Agent-engine work (Loop agent steps via
    /// /kb/loop/agent-run, Agent-engine quick chats) cannot take its route even
    /// though its other calls can — the same local + server checks
    /// `TierRouting.resolve(requiresAgentEngine: true)` applies per call.
    private func agentEngineReason(for feature: RoutedFeature) -> String? {
        guard let tier = routing.tier(for: feature), let route = routing.tier(tier) else { return nil }
        if let local = TierRouting.unusableReason(route, customProviders: customProviders, requiresAgentEngine: true) {
            return local
        }
        guard serverSupported, let status = serverState.status?[tier.rawValue], !status.agentCapable else { return nil }
        return "the server can't run it on the Agent engine (\(TierRouting.describeServerReason(status.agentReason)))"
    }

    private var serverSupported: Bool { TierRouting.serverSupportsRouting(serverState.apiVersion) }

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

    private func note(_ text: String) -> some View {
        Text(text)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Derived state

    /// Why a role set to a tier still runs its default. Auto Tasks run a local
    /// CLI, so they get the CLI constraint (including whether it's installed);
    /// the chat surfaces' Agent-engine constraint depends on each chat and is
    /// applied per turn instead. Server-side refusals come from the last
    /// status fetch.
    private func featureUnusableReason(_ feature: RoutedFeature) -> String? {
        guard let tier = routing.tier(for: feature) else { return nil }
        guard let route = routing.tier(tier) else { return "the \(tier.displayName) tier is not set" }
        let localCLIOnly = feature == .autoTasks
        if let local = TierRouting.unusableReason(route, customProviders: customProviders,
                                                  localCLIOnly: localCLIOnly,
                                                  cliInstalled: TierRouting.isCLIInstalled) {
            return local
        }
        // The version note at the top already covers an old server.
        guard serverSupported else { return nil }
        return TierRouting.serverUnusableReason(tier, server: serverState, localCLIOnly: localCLIOnly)
    }

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

    private func featureBinding(_ feature: RoutedFeature) -> Binding<String> {
        Binding(
            get: { routing.features[feature.rawValue] ?? "" },
            set: { tier in
                var updated = routing
                updated.features[feature.rawValue] = tier.isEmpty ? nil : tier
                apply(updated)
            }
        )
    }

    // MARK: - Persistence + sync

    private func apply(_ updated: TierRoutingConfig) {
        guard updated != routing else { return }
        routing = updated
        if updated.save() {
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

    /// Claude's model list lives only in `LiveModelCache`; without this the
    /// Claude model menu is empty until the Code Assistant panel has opened.
    private func loadClaudeModels() async {
        guard LiveModelCache.models(for: ClaudeCLI.provider) == nil else { return }
        guard let models = try? await api.listProviderModels(ClaudeCLI.provider), !models.isEmpty else { return }
        LiveModelCache.store(models, for: ClaudeCLI.provider)
        modelsRevision += 1
    }
}
