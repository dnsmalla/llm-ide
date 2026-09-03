import Foundation

/// User-configurable LLM provider: name, endpoint, API key, and model list.
/// Persisted to UserDefaults as JSON.
struct CustomProvider: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var name: String              // "GLM", "Ollama", "Mistral", etc.
    var baseURL: String           // "https://open.bigmodel.cn/api/paas/v4" or "http://localhost:8000/v1"
    var apiKey: String            // Vault secret key path (e.g., "glm.apiKey")
    var models: [AIModel]         // List of available models
    var isOpenAICompatible: Bool  // true = use OpenAI request/response format
    var description: String       // "Zhipu GLM 4", "Local Ollama", etc.
    var isEnabled: Bool = true
    /// Optional Anthropic-format endpoint — the provider's second "door"
    /// (Z.AI GLM: `https://api.z.ai/api/anthropic`; DeepSeek:
    /// `https://api.deepseek.com/anthropic`; Ollama: `http://localhost:11434`).
    /// The Claude Agent engine speaks the Anthropic Messages API only, so this
    /// is what lets a non-Claude model run on it; `baseURL` stays the
    /// OpenAI-form endpoint the classic engine dispatches to. Optional so
    /// providers persisted before the field existed decode unchanged (nil).
    var anthropicBaseURL: String? = nil

    init(
        name: String,
        baseURL: String,
        apiKey: String,
        models: [AIModel] = [],
        isOpenAICompatible: Bool = true,
        description: String = "",
        anthropicBaseURL: String? = nil
    ) {
        self.name = name
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.models = models
        self.isOpenAICompatible = isOpenAICompatible
        self.description = description
        self.anthropicBaseURL = anthropicBaseURL
    }

    /// The `custom:<uuid>` id this provider travels under on the wire
    /// (`ChatTransportInput.makeProvider`, the server registry key).
    var wireId: String { "custom:\(id)" }

    /// True when the provider declares an Anthropic-compatible endpoint, i.e.
    /// the Agent engine can run it. Whitespace-only counts as absent — the
    /// server normalizes the same way, so the two can't disagree.
    var canRunAgentEngine: Bool {
        !(anthropicBaseURL ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - Persistence

extension CustomProvider {
    static let defaultsKey = "customProviders"

    static func loadAll() -> [CustomProvider] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey) else { return [] }
        do {
            return try JSONDecoder().decode([CustomProvider].self, from: data)
        } catch {
            return []
        }
    }

    static func saveAll(_ providers: [CustomProvider]) {
        do {
            let data = try JSONEncoder().encode(providers)
            UserDefaults.standard.set(data, forKey: defaultsKey)
            // NOTE: backend registry sync is intentionally NOT done here. This
            // static, model-layer method has no access to the session access
            // token, and a bare URLSession POST to /kb/custom-providers (which
            // sits behind the global `authenticate` middleware) silently 401'd
            // — so the registry was never populated and custom providers never
            // resolved at code-assist time. Sync is driven from the view layer
            // (CustomProvidersSection) via LlmIdeAPIClient.syncCustomProviders,
            // which injects the Bearer token.
        } catch {
            // Silent fail — validation happened in UI
        }
    }

    func save() {
        var all = CustomProvider.loadAll()
        if let idx = all.firstIndex(where: { $0.id == id }) {
            all[idx] = self
        } else {
            all.append(self)
        }
        CustomProvider.saveAll(all)
    }

    func delete() {
        var all = CustomProvider.loadAll()
        all.removeAll { $0.id == id }
        CustomProvider.saveAll(all)
    }

    /// Re-push every locally-persisted provider into the backend registry
    /// (POST /kb/custom-providers). The server keeps this map in memory only,
    /// so call after backend restart and once the user is authenticated.
    static func syncAllToBackend(api: LlmIdeAPIClient) {
        let all = loadAll()
        guard !all.isEmpty else { return }
        Task { try? await api.syncCustomProviders(all) }
    }
}
