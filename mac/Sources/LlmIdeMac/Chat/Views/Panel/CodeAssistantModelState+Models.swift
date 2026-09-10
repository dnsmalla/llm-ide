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
        let base = (liveModels[cli.provider]?.isEmpty == false) ? liveModels[cli.provider]! : cli.models
        let baseIds = Set(base.map(\.id))
        let custom = customModelIds(for: cli.provider)
            .filter { !baseIds.contains($0) }
            .map { AIModel(id: $0, displayName: $0) }
        return base + custom
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
        guard let ids = try? await api.listProviderModels(cli.provider), !ids.isEmpty else { return }
        liveModels[cli.provider] = ids.map { AIModel(id: $0, displayName: $0) }
    }

    /// Switch the active model provider and reset the selected model.
    func switchProvider(_ provider: ProviderSwitch, config: AppConfig, api: LlmIdeAPIClient) {
        switch provider {
        case .builtIn(let tool):
            selectedProvider = tool.rawValue
            selectedModel = tool.defaultModelId
            config.activeCLI = tool.rawValue
            config.defaultModelId = tool.defaultModelId
            Task { await loadModels(for: tool, api: api) }
        case .custom(let customProvider):
            selectedProvider = "custom:\(customProvider.id)"
            selectedModel = customProvider.models.first?.id ?? ""
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
        if !selectedProvider.starts(with: "custom:") {
            config.defaultModelId = match.id
        }
        return nil
    }
}
