import Foundation

/// Model/provider resolution, fetching and persistence.
///
/// This logic used to sit in `ChatComposer.swift` — i.e. in a *view* — where it
/// held `api.listProviderModels` networking, `@AppStorage` JSON encoding, and
/// `config.defaultModelId` writes. It lives on the state object instead so the
/// composer is only markup, and so a second surface can drive model selection
/// without copying any of it.
///
/// `config` and `api` arrive as parameters rather than stored dependencies:
/// this type is `@Observable` state shared with SwiftUI, and giving it an
/// environment of its own is what makes such objects hard to construct in
/// isolation.
extension CodeAssistantModelState {
    /// UserDefaults key backing the composer's `@AppStorage` of the same name.
    /// Read/written directly here so both stay in sync — SwiftUI's `@AppStorage`
    /// observes the store, not the property.
    static let customModelsKey = "MEETNOTES_CUSTOM_MODELS"

    private static func customModelsDict() -> [String: [String]] {
        let raw = UserDefaults.standard.string(forKey: customModelsKey) ?? "{}"
        return (try? JSONDecoder().decode([String: [String]].self, from: Data(raw.utf8))) ?? [:]
    }

    /// User-added model ids for a provider.
    func customModelIds(for provider: String) -> [String] {
        Self.customModelsDict()[provider] ?? []
    }

    /// Models to offer for a built-in provider: the live list when one has been
    /// fetched, otherwise the built-in static list (keeps the picker populated
    /// when no key is set or the fetch failed), plus any user-added ids.
    func models(for cli: AICliTool) -> [AIModel] {
        // Panel's own fetch, else the persisted list Settings also offers from
        // (so a Settings pick is never filtered out as "not offered"), else built-ins.
        let base = (liveModels[cli.provider]?.isEmpty == false)
            ? liveModels[cli.provider]!
            : (cli.pickerModels.isEmpty ? cli.models : cli.pickerModels)
        let baseIds = Set(base.map(\.id))
        let custom = customModelIds(for: cli.provider)
            .filter { !baseIds.contains($0) }
            .map { AIModel(id: $0, displayName: $0) }
        let all = base + custom
        return cli == .claudeCode ? AIModel.including(selected: selectedModel, in: all) : all
    }

    /// The model the NEXT turn sends and the composer chip names — one answer
    /// for both, so the chip never labels one model while the chat sends another.
    ///
    /// An explicit pick wins; otherwise the Settings model for the current
    /// mode (`PurposeModelPolicy`), skipping one this provider does not offer;
    /// otherwise `selectedModel`. Custom providers bypass purposes: those ids
    /// belong to the built-in provider the user set them for.
    func effectiveModelId(config: AppConfig) -> String {
        if modelIsExplicit || selectedProvider.starts(with: "custom:") { return selectedModel }
        let offered = modelsForCurrentProvider()
        let id = config.purposeModels.modelId(forMode: selectedMode.rawValue, explicit: nil) { candidate in
            AIModel.isOffered(candidate, in: offered)
        }
        return id ?? selectedModel
    }

    /// `effectiveModelId`, or nil when empty — the wire sends no `model` then,
    /// and the engine uses the account default.
    func effectiveModelIdOrNil(config: AppConfig) -> String? {
        let id = effectiveModelId(config: config)
        return id.isEmpty ? nil : id
    }

    /// The effort levels of the model the next turn sends. Custom providers
    /// and non-Claude tools never get an effort picker.
    func effortLevelsForNextTurn(config: AppConfig) -> [String] {
        guard !selectedProvider.starts(with: "custom:"),
              (AICliTool(rawValue: selectedProvider) ?? .claudeCode) == .claudeCode else { return [] }
        let rows = models(for: .claudeCode).map { (id: $0.id, levels: $0.effortLevels) }
        return EffortChoice.levels(forModelId: effectiveModelId(config: config),
                                   in: rows, baseId: AIModel.baseId)
    }

    /// Models for the currently selected provider, built-in or custom.
    func modelsForCurrentProvider() -> [AIModel] {
        if selectedProvider.starts(with: "custom:") {
            return customProviders.first(where: { "custom:\($0.id)" == selectedProvider })?.models ?? []
        }
        guard let cli = AICliTool(rawValue: selectedProvider) else { return [] }
        return models(for: cli)
    }

    /// Append a custom model id for a provider and select it.
    func addCustomModel(_ id: String, provider: String, config: AppConfig) {
        var dict = Self.customModelsDict()
        var list = dict[provider] ?? []
        if !list.contains(id) { list.append(id) }
        dict[provider] = list
        if let data = try? JSONEncoder().encode(dict), let s = String(data: data, encoding: .utf8) {
            UserDefaults.standard.set(s, forKey: Self.customModelsKey)
        }
        selectedModel = id
        modelIsExplicit = true
        config.modelPickIsExplicit = true
        // Persist so the iPhone chat proxy forwards this model too. Only
        // reachable from the built-in "Add model…" alert, so the provider is
        // always a built-in tool — but the guard keeps that assumption local.
        if !selectedProvider.starts(with: "custom:") {
            config.defaultModelId = id
        }
    }

    /// Fetch the provider's live chat models. Best-effort: silent on failure,
    /// leaving `models(for:)` on the built-in fallback list.
    func loadModels(for cli: AICliTool, api: LlmIdeAPIClient) async {
        guard let models = try? await api.listProviderModels(cli.provider), !models.isEmpty else { return }
        liveModels[cli.provider] = models
        // Persist every provider's list so every other surface (menu-bar chat,
        // Settings pickers, the startup id migration) follows it — see
        // LiveModelCache. Only Claude's list drives `models`/the default id.
        LiveModelCache.store(models, for: cli.provider)
    }

    /// Switch the active model provider and reset the selected model.
    func switchProvider(_ provider: ProviderSwitch, config: AppConfig, api: LlmIdeAPIClient) {
        switch provider {
        case .builtIn(let tool):
            // Coming back from a custom provider, or re-clicking the active one,
            // is not a provider change: the purpose models still apply.
            let changed = config.activeCLI != tool.rawValue
            selectedProvider = tool.rawValue
            selectedModel = tool.defaultModelId
            modelIsExplicit = false
            config.activeCLI = tool.rawValue
            config.defaultModelId = tool.defaultModelId
            if changed {
                // Purpose models were picked for the previous provider.
                config.resetPurposeModels()
                config.modelPickIsExplicit = false
            }
            Task { await loadModels(for: tool, api: api) }
        case .custom(let customProvider):
            selectedProvider = "custom:\(customProvider.id)"
            selectedModel = customProvider.models.first?.id ?? ""
        }
    }

    /// Settings changed the DEFAULT provider (`config.activeCLI`): move the
    /// composer's provider with it, not just its model. Moving only the model
    /// left e.g. provider `anthropic` paired with a `gpt-…` model (or a
    /// `custom:<uuid>` provider with a built-in id it doesn't serve), and the
    /// chip read "Claude / gpt-…".
    func followDefaultProvider(activeCLI: String, defaultModelId: String) {
        // `.claudeCode.rawValue`, not `ClaudeCLI.provider` ("anthropic",
        // not an `AICliTool` value — `modelsForCurrentProvider` found no models).
        selectedProvider = activeCLI.isEmpty ? AICliTool.claudeCode.rawValue : activeCLI
        selectedModel = defaultModelId
        modelIsExplicit = false
    }

    /// After the custom-provider list changed: if the selected
    /// `custom:<uuid>` was deleted or disabled, fall back to the default
    /// provider; if only its selected model went away, take its first model.
    /// Left alone, the dead id kept being sent (the server couldn't resolve
    /// it) while the chip fell back to reading "Claude".
    func reconcileCustomSelection(activeCLI: String, defaultModelId: String) {
        guard selectedProvider.starts(with: "custom:") else { return }
        guard let provider = customProviders.first(where: { "custom:\($0.id)" == selectedProvider }),
              provider.isEnabled else {
            followDefaultProvider(activeCLI: activeCLI, defaultModelId: defaultModelId)
            return
        }
        if !provider.models.contains(where: { $0.id == selectedModel }) {
            selectedModel = provider.models.first?.id ?? ""
        }
    }

    /// UserDefaults key of Settings' "Code Assistant provider" override: a
    /// custom provider's id, or "" to follow the default provider
    /// (`config.activeCLI`). Kept apart from `activeCLI` on purpose — Loop,
    /// Auto Tasks, the phone bridge and quick chat all read `activeCLI` as an
    /// `AICliTool` raw value, and a `custom:<id>` there would leak into them.
    static let composerProviderKey = "codeAssistProvider"

    /// Point the composer at the provider Settings chose for it: the custom
    /// provider named by `overrideId` while it exists and is enabled, else the
    /// default provider. A no-op when already there, so an explicit model pick
    /// on the current provider survives a re-apply (appear, Settings edits).
    ///
    /// `agentEngineOnly`: the chat runs on the Agent v2 engine. A provider
    /// without an Anthropic-compatible URL would drop that turn to the legacy
    /// loop while the v2 SDK session sits untouched — the next v2 turn would
    /// resume with no memory of it — so such an override is skipped there
    /// (the deleted provider chip filtered the same way).
    func applyComposerProvider(overrideId: String, activeCLI: String, defaultModelId: String,
                               agentEngineOnly: Bool = false) {
        if !overrideId.isEmpty,
           let provider = customProviders.first(where: { $0.id == overrideId && $0.isEnabled }),
           !agentEngineOnly || provider.canRunAgentEngine {
            let target = "custom:\(provider.id)"
            if selectedProvider != target {
                selectedProvider = target
                selectedModel = provider.models.first?.id ?? ""
            } else if !provider.models.contains(where: { $0.id == selectedModel }) {
                selectedModel = provider.models.first?.id ?? ""
            }
            return
        }
        let fallback = activeCLI.isEmpty ? AICliTool.claudeCode.rawValue : activeCLI
        if selectedProvider != fallback {
            followDefaultProvider(activeCLI: activeCLI, defaultModelId: defaultModelId)
        }
    }

    enum ProviderSwitch {
        case builtIn(AICliTool)
        case custom(CustomProvider)
    }

    /// Resolve `/model <query>` against the current provider's known models —
    /// exact id/displayName match first, substring fallback — and select it the
    /// same way tapping a picker item does, including the `config.defaultModelId`
    /// sync for built-in providers so the iPhone chat proxy sees the change.
    ///
    /// - Returns: `nil` on success, or the message to show the user. The caller
    ///   decides where that message goes; this type does not reach into a chat
    ///   engine to display it.
    func resolveModelCommand(_ query: String, config: AppConfig) -> String? {
        guard !query.isEmpty else {
            return "Usage: /model <name> — e.g. /model sonnet, /model gpt-5"
        }
        let candidates = modelsForCurrentProvider()
        let q = query.lowercased()
        guard let match = candidates.first(where: { $0.id.lowercased() == q || $0.displayName.lowercased() == q })
            ?? candidates.first(where: { $0.id.lowercased().contains(q) || $0.displayName.lowercased().contains(q) })
        else {
            let available = candidates.map(\.displayName).joined(separator: ", ")
            return "No model matching \"\(query)\" for the current provider.\(available.isEmpty ? "" : " Available: \(available)")"
        }
        selectedModel = match.id
        modelIsExplicit = true
        // Persisted flag is for the built-in provider only (see handleOnAppear).
        if !selectedProvider.starts(with: "custom:") { config.modelPickIsExplicit = true }
        if !selectedProvider.starts(with: "custom:") {
            config.defaultModelId = match.id
        }
        return nil
    }
}
