import SwiftUI
import os.log

private let tierRoutingSectionLogger = Logger(subsystem: "com.llmide.macapp", category: "TierRouting")

/// Settings card for tier routing: three tiers (provider + model each) and the
/// tier each role uses. Every row defaults to "Default", which is exactly the
/// behaviour before tier routing existed.
struct TierRoutingSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @State private var routing = TierRoutingConfig.load()
    @State private var customProviders = CustomProvider.loadAll()
    @State private var syncError: String?
    /// Bumped when Claude's live model list lands, so the menus re-read it.
    @State private var modelsRevision = 0

    var body: some View {
        SettingsSectionCard(icon: "dial.medium", title: "Tier Routing") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SettingsHint("Run each role on a cheaper or stronger model. Pick a provider and model per tier, then choose which tier each role uses. Anything left on Default — or a tier that can't be used — runs exactly as before.")

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
        }
        .task {
            routing = TierRoutingConfig.load()
            customProviders = CustomProvider.loadAll()
            sync()   // the server's copy is per user; re-push like custom providers
            await loadClaudeModels()
        }
    }

    // MARK: - Rows

    private func tierRow(_ tier: RoutingTier) -> some View {
        let route = routing.tier(tier)
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
                if let route {
                    Picker("Model", selection: modelBinding(tier)) {
                        ForEach(modelChoices(for: route), id: \.id) { model in
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
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Derived state

    /// Why a role set to a tier still runs its default. Auto Tasks run a local
    /// CLI, so they get the CLI constraint; the chat surfaces' Agent-engine
    /// constraint depends on each chat and is applied per turn instead.
    private func featureUnusableReason(_ feature: RoutedFeature) -> String? {
        guard let tier = routing.tier(for: feature) else { return nil }
        guard let route = routing.tier(tier) else { return "the \(tier.displayName) tier is not set" }
        return TierRouting.unusableReason(route, customProviders: customProviders,
                                          localCLIOnly: feature == .autoTasks)
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
    private func modelChoices(for route: TierRoute) -> [AIModel] {
        let list = models(forProvider: route.provider)
        guard !route.model.isEmpty, !list.contains(where: { $0.id == route.model }) else { return list }
        return list + [AIModel(id: route.model, displayName: route.model)]
    }

    // MARK: - Bindings

    private func providerBinding(_ tier: RoutingTier) -> Binding<String> {
        Binding(
            get: { routing.tier(tier)?.provider ?? "" },
            set: { provider in
                var updated = routing
                if provider.isEmpty {
                    updated.tiers[tier.rawValue] = nil
                } else if updated.tiers[tier.rawValue]?.provider != provider {
                    // A new provider starts on its first model; the old model
                    // id belongs to the previous provider.
                    let first = models(forProvider: provider).first?.id ?? ""
                    updated.tiers[tier.rawValue] = TierRoute(provider: provider, model: first)
                }
                apply(updated)
            }
        )
    }

    private func modelBinding(_ tier: RoutingTier) -> Binding<String> {
        Binding(
            get: { routing.tier(tier)?.model ?? "" },
            set: { model in
                guard var route = routing.tier(tier) else { return }
                route.model = model
                var updated = routing
                updated.tiers[tier.rawValue] = route
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
            sync()
        } else {
            syncError = "Couldn't save the routing table."
        }
    }

    /// Fire-and-forget push; the failure is shown, not swallowed, because an
    /// unsynced table silently leaves the server's roles on their defaults.
    private func sync() {
        let snapshot = routing
        Task {
            do {
                try await api.syncTierRouting(snapshot)
                syncError = nil
            } catch {
                tierRoutingSectionLogger.error("Tier routing sync failed: \(error.localizedDescription, privacy: .public)")
                syncError = "Couldn't sync tier routing to the server: \(error.localizedDescription). Server-side roles use their defaults until it succeeds."
            }
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
