import Foundation

/// A provider the user picked in the composer for one chat.
struct ProviderPick: Equatable {
    var provider: String
    var model: String
}

/// Composer provider picks per chat (session id), so returning to a chat
/// restores its provider. Process-wide because the panel's model state is
/// rebuilt on every section switch; in memory only, so a relaunch starts every
/// chat on Settings' default again.
@MainActor
enum ComposerProviderPicks {
    static var bySession: [String: ProviderPick] = [:]
}

/// One provider's block in the composer's grouped model menu.
struct ComposerProviderSection: Identifiable, Equatable {
    /// The `selectedProvider` value this section selects: an `AICliTool` raw
    /// value or `custom:<uuid>`.
    let id: String
    let title: String
    let models: [AIModel]
    /// Whether the Agent engine can run this provider. A chat already running
    /// on the Agent engine cannot move to a provider that cannot.
    let runsOnAgentEngine: Bool
    /// A provider-catalog connection (reached through the session router and the adapter).
    var catalog: Bool = false
    /// Catalog only: model id to its "tools supported" flag (the menu's badge).
    var toolsByModel: [String: Bool] = [:]
    /// Catalog only: why the section cannot be picked right now (router off, provider chat off).
    var unavailableNote: String? = nil
    /// Catalog only: a non-blocking note (tools are off); the section stays pickable.
    var infoNote: String? = nil
}

/// The composer's grouped model menu: every provider that is set up, not only
/// Settings' default. A pick changes the displayed chat's provider and model
/// and never writes Settings.
extension CodeAssistantModelState {
    /// The providers the menu lists. With `available` known
    /// (`ProviderAvailabilityStore`): the providers that can run — Claude only
    /// when its CLI or key is there. While unknown (`nil`): Claude always (its
    /// CLI login is the app's baseline) and another built-in once its key is
    /// in the vault. Either way, every enabled custom provider (when known,
    /// only those that can run) and whatever is selected now, so the chip's
    /// provider is never missing from its own menu. `serverUsableProvider` is
    /// Standard's provider when the server reports Standard usable (it can run
    /// providers via env keys the Mac cannot see): listed regardless.
    func composerProviderSections(capableProviders: Set<String>,
                                  available: Set<String>? = nil,
                                  serverUsableProvider: String? = nil,
                                  routerOn: Bool = false,
                                  routerPrefOn: Bool = false) -> [ComposerProviderSection] {
        var sections: [ComposerProviderSection] = []
        for tool in AICliTool.selectable {
            let isCurrent = tool.rawValue == selectedProvider
            let hasKey = tool.vaultKey.map { configuredSecretKeys?.contains($0) == true } ?? false
            let listed: Bool
            if let available, ProviderAvailability.judges(tool.provider) {
                listed = available.contains(tool.provider) || tool.provider == serverUsableProvider
            } else {
                listed = tool == .claudeCode || hasKey
            }
            let runs = capableProviders.contains(tool.provider)
            // A provider that cannot run a chat any more is noise unless it is the one selected AND the user has
            // a key for it (then its reason is shown); an unconnected one is not listed at all.
            guard Self.shouldList(runs: runs, listed: listed, isCurrent: isCurrent, hasKey: hasKey || tool == .claudeCode) else { continue }
            var models = models(for: tool, includingSelected: isCurrent)
            if isCurrent { models = Self.listing(selectedModel, in: models) }
            sections.append(ComposerProviderSection(
                id: tool.rawValue, title: tool.displayName, models: models,
                runsOnAgentEngine: runs, unavailableNote: runs ? nil : ComposerCatalog.unsupportedNote))
        }
        for provider in customProviders {
            let runs = capableProviders.contains(provider.wireId)
            let isCurrent = provider.wireId == selectedProvider
            let listed = provider.isEnabled && ProviderAvailability.isListed(provider.wireId, available: available)
            guard Self.shouldList(runs: runs, listed: listed, isCurrent: isCurrent, hasKey: true) else { continue }
            var models = provider.models
            if isCurrent { models = Self.listing(selectedModel, in: models) }
            sections.append(ComposerProviderSection(
                id: provider.wireId, title: provider.name, models: models,
                runsOnAgentEngine: runs, unavailableNote: runs ? nil : ComposerCatalog.unsupportedNote))
        }
        sections += ComposerCatalog.sections(catalogConnections, routerOn: routerOn, providerChatEnabled: catalogProviderChatEnabled,
                                          routerPrefOn: routerPrefOn)
        return sections.filter { !$0.models.isEmpty }
    }

    /// Whether a built-in or custom provider's group is in the menu. One that can run a chat follows the usual
    /// rule (set up, or selected). One that cannot (no Anthropic-compatible endpoint, built-in key only) is
    /// hidden unless it is selected and the user has a key for it, so an unconnected "OpenAI: unavailable"
    /// never shows.
    static func shouldList(runs: Bool, listed: Bool, isCurrent: Bool, hasKey: Bool) -> Bool {
        runs ? (listed || isCurrent) : (isCurrent && hasKey)
    }

    /// `models` with `id` appended when it is missing — the chip names the
    /// selected model, so its section must show it.
    static func listing(_ id: String, in models: [AIModel]) -> [AIModel] {
        guard !id.isEmpty, !models.contains(where: { $0.id == id }) else { return models }
        return models + [AIModel(id: id, displayName: id)]
    }

    /// Whether a section can be picked in the displayed chat: every chat runs on the Agent engine, so a
    /// section is pickable exactly when its provider can run one right now (no note).
    static func canPick(_ section: ComposerProviderSection, chatIsEmpty: Bool, chatRunsOnAgentEngine: Bool) -> Bool {
        section.unavailableNote == nil && section.runsOnAgentEngine
    }

    /// The provider Settings gives the composer: the "Code Assistant provider"
    /// custom override while it exists and is enabled, else the default.
    func settingsProvider(overrideId: String, activeCLI: String) -> String {
        if !overrideId.isEmpty, customProviders.contains(where: { $0.id == overrideId && $0.isEnabled }) {
            return "custom:\(overrideId)"
        }
        return activeCLI.isEmpty ? AICliTool.claudeCode.rawValue : activeCLI
    }

    /// Select `model` on `provider` for the chat `sessionID`. Picking on
    /// Settings' own provider is an ordinary model pick; any other provider is
    /// remembered for this chat only.
    @MainActor func pick(model: String, provider: String, sessionID: String, settingsProvider: String) {
        displayedSessionID = sessionID
        selectedProvider = provider
        selectedModel = model
        modelIsExplicit = true
        if provider == settingsProvider {
            providerIsExplicit = false
            ComposerProviderPicks.bySession[sessionID] = nil
        } else {
            providerIsExplicit = true
            ComposerProviderPicks.bySession[sessionID] = ProviderPick(provider: provider, model: model)
        }
    }

    /// Remember a model chosen on the CURRENT provider (a menu pick, "Add
    /// model…", `/model`). On Settings' own built-in provider it is the
    /// persisted explicit pick that `handleOnAppear` restores; on a provider
    /// picked for this chat only it updates that chat's pick instead —
    /// persisting it would restore another provider's model onto Settings'.
    @MainActor func persistModelChoice(_ id: String, config: AppConfig) {
        if providerIsExplicit {
            if !displayedSessionID.isEmpty {
                ComposerProviderPicks.bySession[displayedSessionID] = ProviderPick(provider: selectedProvider, model: id)
            }
        } else if !selectedProvider.starts(with: "custom:") {
            config.modelPickIsExplicit = true
            config.explicitModelId = id
        }
    }

    /// Back on Settings' provider after a chat that had its own: the model the
    /// user saved for it, not Standard's (`followDefaultProvider` resets to
    /// `defaultModelId` and drops the explicit flag).
    func restoreSettingsModel(config: AppConfig) {
        guard !selectedProvider.starts(with: "custom:") else { return }
        selectedModel = Self.restoredModel(isExplicit: config.modelPickIsExplicit,
                                           explicitId: config.explicitModelId,
                                           defaultModelId: config.defaultModelId)
        modelIsExplicit = config.modelPickIsExplicit
    }

    /// The displayed chat changed: restore its own provider pick, if it made
    /// one and that provider still exists. Returns false when the chat follows
    /// Settings, after dropping the previous chat's pick from the composer.
    @discardableResult @MainActor
    func restoreProviderPick(for sessionID: String) -> Bool {
        displayedSessionID = sessionID
        if let pick = ComposerProviderPicks.bySession[sessionID], providerExists(pick.provider) {
            selectedProvider = pick.provider
            selectedModel = pick.model
            modelIsExplicit = true
            providerIsExplicit = true
            return true
        }
        ComposerProviderPicks.bySession[sessionID] = nil
        providerIsExplicit = false
        return false
    }

    private func providerExists(_ provider: String) -> Bool {
        if provider.hasPrefix("custom:cat-") { return CatalogConnectionIndex.shared.knows(provider) }
        if provider.hasPrefix("custom:") {
            return customProviders.contains { $0.wireId == provider && $0.isEnabled }
        }
        return AICliTool(rawValue: provider) != nil
    }

    /// Fill what the grouped menu needs: which keys are stored, then each
    /// listed built-in provider's live models. Best-effort, like `loadModels`.
    @MainActor func loadComposerProviders(api: LlmIdeAPIClient) async {
        if let keys = try? await api.configuredSecretKeys() { configuredSecretKeys = keys }
        for tool in AICliTool.selectable {
            let hasKey = tool.vaultKey.map { configuredSecretKeys?.contains($0) == true } ?? false
            guard tool == .claudeCode || hasKey, liveModels[tool.provider]?.isEmpty != false else { continue }
            await loadModels(for: tool, api: api)
        }
        await loadCatalogConnections(api: api)
    }

    /// The provider-catalog connections and their models with the tools flag (`refreshCatalogConnectionIndex`).
    @MainActor func loadCatalogConnections(api: LlmIdeAPIClient) async {
        catalogConnections = await api.refreshCatalogConnectionIndex()
        catalogProviderChatEnabled = CatalogConnectionIndex.shared.providerChatEnabled
    }
}
