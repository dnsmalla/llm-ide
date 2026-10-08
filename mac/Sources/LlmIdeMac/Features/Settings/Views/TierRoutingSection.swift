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
    @AppStorage(TierDefaults.composerProviderKey) private var composerProviderId = ""
    /// Standard first: it is the default and the only required tier.
    private static let tierOrder: [RoutingTier] = [.standard, .strong, .cheap]
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
        SettingsSectionCard(icon: "dial.medium", title: "Tiers & Roles") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Standard is the default: new chats and every role on this Mac left on Standard use it. Strong and Cheap are optional. Then choose the tier each role uses. A tier that can't be used is skipped silently — Standard on this Mac, the built-in default on the server.")

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
            await loadClaudeModels()
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
        let current = TierDefaults.describeCurrentDefault(activeCLI: config.activeCLI, defaultModelId: config.defaultModelId)
        let reason = route.flatMap { TierRouting.unusableReason($0, customProviders: customProviders) }
        if let warning = TierDefaults.standardWarning(isSet: route != nil, unusableReason: reason, currentDefault: current) {
            Text(warning)
                .font(Typography.caption)
                .foregroundStyle(theme.current.warning)
                .fixedSize(horizontal: false, vertical: true)
        } else if let route {
            if !TierDefaults.isApplied(route, activeCLI: config.activeCLI, defaultModelId: config.defaultModelId,
                                       composerProviderId: composerProviderId) {
                HStack(spacing: Spacing.sm) {
                    note("New chats still use \(current).")
                    Button("Make Standard the default") { config.applyStandardTier(route) }
                        .controlSize(.small)
                }
            }
            if TierRouting.unusableReason(route, customProviders: customProviders, requiresAgentEngine: true) != nil {
                note(TierDefaults.standardAgentEngineNote)
            }
            if serverSupported, let status = serverState.status?[RoutingTier.standard.rawValue] {
                if !status.usable {
                    note("server roles on Standard use their built-in default — the server can't run it: \(TierRouting.describeServerReason(status.reason))")
                } else if let via = TierRouting.describeVia(status.via, provider: route.provider) {
                    note(via)
                }
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
                    // What an unset role runs: Standard on this Mac, the
                    // server's own default for server roles.
                    Text(feature.unsetLabel).tag("")
                    ForEach(RoutingTier.allCases) { tier in
                        Text(tier.displayName).tag(tier.rawValue)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: 160)
            }
            .help(TierDefaults.purpose(for: feature).map(TierDefaults.modesHelp) ?? "")
            if let reason = featureUnusableReason(feature) {
                note("uses \(feature.unsetLabel) — \(reason)")
            } else if feature.group == .chat {
                chatRoleNotes(feature)
            } else if feature == .loop, let reason = agentEngineReason(for: .loop) {
                // The replay takes the route; the agent steps (the bulk of a
                // Loop's cost) run on the Agent SDK and keep Standard.
                note("agent steps use Standard — \(reason). Only Claude or a custom provider "
                     + "with an Anthropic-compatible URL can run them.")
            } else if feature == .quickChat, let reason = agentEngineReason(for: .quickChat) {
                note("on Agent-engine chats uses Standard — \(reason). Only Claude or a custom provider "
                     + "with an Anthropic-compatible URL can run them.")
            }
        }
    }

    /// Chat-mode rows: a mode's tier only swaps the MODEL, so it applies to
    /// chats already on the tier's provider; a v2 chat also needs an
    /// Anthropic-compatible one. An unset row names a kept legacy model.
    @ViewBuilder
    private func chatRoleNotes(_ feature: RoutedFeature) -> some View {
        if let tier = routing.tier(for: feature), let route = routing.tier(tier) {
            note(TierDefaults.chatRoleProviderNote(providerName: providerName(route.provider)))
            if let reason = agentEngineReason(for: feature) {
                note("uses Standard on Agent-engine chats — \(reason)")
            }
        } else if let purpose = TierDefaults.purpose(for: feature),
                  let legacy = config.purposeModelIds[purpose], !legacy.isEmpty {
            note(TierDefaults.legacyNote(purpose: purpose, model: legacy))
        }
    }

    private func providerName(_ provider: String) -> String {
        if let customId = TierRouting.customProviderId(provider) {
            return customProviders.first { $0.id == customId }?.name ?? provider
        }
        return TierRouting.builtInProviders.first { $0.wireId == provider }?.tool.displayName ?? provider
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
        // Chat roles never reach the server's resolver: only the local check applies.
        guard feature.group != .chat, serverSupported,
              let status = serverState.status?[tier.rawValue], !status.agentCapable else { return nil }
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
        // Chat roles only pick a model on the Mac — no server status applies.
        // The version note at the top already covers an old server.
        guard feature.group != .chat, serverSupported else { return nil }
        return TierRouting.serverUnusableReason(tier, server: serverState, localCLIOnly: localCLIOnly)
            ?? TierRouting.serverFeatureUnusableReason(feature, server: serverState)
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
                // Re-picking the current value must not clear a composer pick.
                guard updated != routing else { return }
                if let purpose = TierDefaults.purpose(for: feature) {
                    // The choice replaces a kept legacy purpose model, and — as
                    // editing a purpose picker did — re-decides the model from
                    // Settings, so a composer pick no longer overrides it.
                    config.purposeModelIds[purpose] = nil
                    config.modelPickIsExplicit = false
                    config.explicitModelId = ""
                }
                apply(updated)
            }
        )
    }

    // MARK: - Persistence + sync

    private func apply(_ updated: TierRoutingConfig) {
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

    /// Claude's model list lives only in `LiveModelCache`; without this the
    /// Claude model menu is empty until the Code Assistant panel has opened.
    private func loadClaudeModels() async {
        guard LiveModelCache.models(for: ClaudeCLI.provider) == nil else { return }
        guard let models = try? await api.listProviderModels(ClaudeCLI.provider), !models.isEmpty else { return }
        LiveModelCache.store(models, for: ClaudeCLI.provider)
        modelsRevision += 1
    }
}
