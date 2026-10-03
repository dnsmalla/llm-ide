import Foundation
import os.log

private let customProviderLogger = Logger(subsystem: "com.llmide.macapp", category: "CustomProvider")

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

    enum CodingKeys: String, CodingKey {
        case id, name, baseURL, apiKey, models, isOpenAICompatible, description, isEnabled, anthropicBaseURL
    }

    /// Tolerant decoder: every field falls back to its default when absent, so
    /// a field added or renamed across versions never makes the WHOLE list
    /// undecodable (which used to read as "no providers" and then get pushed
    /// to the server as an empty registry).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        baseURL = try c.decodeIfPresent(String.self, forKey: .baseURL) ?? ""
        // An id-less entry must get the SAME id on every load. A random UUID
        // here meant save() could never match the entry again and appended a
        // duplicate each time; deriving it from name+baseURL keeps it stable
        // (and it is written back with the id on the next save).
        id = try c.decodeIfPresent(String.self, forKey: .id)
            ?? Self.stableId(name: name, baseURL: baseURL)
        apiKey = try c.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        models = try c.decodeIfPresent([AIModel].self, forKey: .models) ?? []
        isOpenAICompatible = try c.decodeIfPresent(Bool.self, forKey: .isOpenAICompatible) ?? true
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        anthropicBaseURL = try c.decodeIfPresent(String.self, forKey: .anthropicBaseURL)
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

    /// Outcome of reading the persisted list. "Nothing stored" and "stored but
    /// unreadable" are different facts: only the former may be pushed to the
    /// server as an empty registry.
    enum LoadOutcome: Equatable {
        case loaded([CustomProvider])
        case failed
    }

    /// Deterministic UUID string for entries persisted without an `id`.
    static func stableId(name: String, baseURL: String) -> String {
        let high = stableHash(Data("\(name)\u{0}\(baseURL)".utf8))
        let low = stableHash(Data("\(baseURL)\u{0}\(name)\u{0}id".utf8))
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in 0..<8 {
            bytes[i] = UInt8(truncatingIfNeeded: high >> UInt64(8 * i))
            bytes[8 + i] = UInt8(truncatingIfNeeded: low >> UInt64(8 * i))
        }
        let uuid: uuid_t = (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
        return UUID(uuid: uuid).uuidString
    }

    /// Makes ids unique. Two id-less entries with the same name+baseURL derive
    /// the same stable id; duplicate ForEach ids and save()/delete() touching
    /// the wrong entry follow. The first occurrence keeps its id, later ones
    /// fold their occurrence index into the hash, so the result is
    /// deterministic across loads.
    static func uniquingIds(_ providers: [CustomProvider]) -> [CustomProvider] {
        var seen = Set<String>()
        var result: [CustomProvider] = []
        for var provider in providers {
            var occurrence = 1
            while seen.contains(provider.id) {
                occurrence += 1
                provider.id = stableId(name: "\(provider.name)#\(occurrence)", baseURL: provider.baseURL)
            }
            seen.insert(provider.id)
            result.append(provider)
        }
        return result
    }

    /// Read without side effects (no stash). `.loaded([])` when nothing stored.
    private static func readStored(from defaults: UserDefaults) -> (outcome: LoadOutcome, data: Data?, error: Error?) {
        guard let data = defaults.data(forKey: defaultsKey) else { return (.loaded([]), nil, nil) }
        do {
            let decoded = try JSONDecoder().decode([CustomProvider].self, from: data)
            return (.loaded(uniquingIds(decoded)), data, nil)
        } catch {
            return (.failed, data, error)
        }
    }

    /// Read the persisted list, distinguishing an empty list from a decode
    /// failure. On failure the undecodable blob is copied aside (once per
    /// distinct content) and left in place; it is NOT removed, so a launch-time
    /// sync still sees `.failed` instead of a clean-looking empty list.
    ///
    /// - Parameter stashDirectory: where the copy goes; defaults to the
    ///   Application Support root. Injectable so tests don't touch the real one.
    static func load(from defaults: UserDefaults = .standard, stashDirectory: URL? = nil) -> LoadOutcome {
        let read = readStored(from: defaults)
        if case .failed = read.outcome, let data = read.data, let error = read.error {
            _ = stashUndecodable(data, error: error, directory: stashDirectory)
        }
        return read.outcome
    }

    /// True while the stored list exists but cannot be decoded. `save()`,
    /// `delete()` and `saveAll` refuse to write in this state (they would
    /// replace the unreadable data with just the new entry), so Settings should
    /// check this and offer `discardUnreadableList` instead of a silent no-op.
    static var isListUnreadable: Bool { isListUnreadable(in: .standard) }

    static func isListUnreadable(in defaults: UserDefaults) -> Bool {
        if case .failed = readStored(from: defaults).outcome { return true }
        return false
    }

    /// Explicit recovery from an unreadable list: remove it, but ONLY after a
    /// verified copy exists on disk. Returns false (and removes nothing) when
    /// the list is readable or the copy could not be written.
    @discardableResult
    static func discardUnreadableList(from defaults: UserDefaults = .standard, stashDirectory: URL? = nil) -> Bool {
        let read = readStored(from: defaults)
        guard case .failed = read.outcome, let data = read.data, let error = read.error else { return false }
        guard stashUndecodable(data, error: error, directory: stashDirectory) else { return false }
        defaults.removeObject(forKey: defaultsKey)
        return true
    }

    /// Source-compatible reader: an unreadable blob yields [] for display. Use
    /// `load()` where the difference matters (backend sync).
    static func loadAll() -> [CustomProvider] {
        if case .loaded(let providers) = load() { return providers }
        return []
    }

    /// FNV-1a, so the stash file name is stable across launches and repeated
    /// loads of the same bad blob don't write a new file each time.
    private static func stableHash(_ data: Data) -> UInt64 {
        data.reduce(14695981039346656037 as UInt64) { ($0 ^ UInt64($1)) &* 1099511628211 }
    }

    /// Returns true only when a copy with identical bytes exists on disk, so
    /// callers can safely remove/overwrite the original afterwards.
    private static func stashUndecodable(_ data: Data, error: Error, directory: URL?) -> Bool {
        let fm = FileManager.default
        let dir = directory ?? AppIdentity.applicationSupportRoot(fileManager: fm)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let backup = dir.appendingPathComponent("\(defaultsKey).json.corrupt-\(String(stableHash(data), radix: 16))")
        if fm.fileExists(atPath: backup.path), fm.contents(atPath: backup.path) == data { return true }
        do {
            try data.write(to: backup, options: .atomic)
            guard fm.contents(atPath: backup.path) == data else {
                customProviderLogger.error("Stash of \(defaultsKey, privacy: .public) failed verification")
                return false
            }
            customProviderLogger.warning("Unreadable \(defaultsKey, privacy: .public) stashed to \(backup.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return true
        } catch {
            customProviderLogger.error("Unreadable \(defaultsKey, privacy: .public) could not be stashed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Persist the list. Returns false (writing nothing) while the stored list
    /// is unreadable or on an encode failure; true when written.
    @discardableResult
    static func saveAll(_ providers: [CustomProvider], to defaults: UserDefaults = .standard) -> Bool {
        // WHY: loadAll() reads an undecodable blob as [], so a naive write would
        // replace the user's (recoverable) providers with just the new one.
        guard !isListUnreadable(in: defaults) else {
            customProviderLogger.error("Refusing to overwrite unreadable \(defaultsKey, privacy: .public)")
            return false
        }
        do {
            let data = try JSONEncoder().encode(providers)
            defaults.set(data, forKey: defaultsKey)
            // Views holding a loadAll() snapshot (the chat panel's provider
            // menu / Agent-engine hint) reload on this; see NotificationNames.
            NotificationCenter.default.post(name: .customProvidersChanged, object: nil)
            // NOTE: backend registry sync is intentionally NOT done here. This
            // static, model-layer method has no access to the session access
            // token, and a bare URLSession POST to /kb/custom-providers (which
            // sits behind the global `authenticate` middleware) silently 401'd
            // — so the registry was never populated and custom providers never
            // resolved at code-assist time. Sync is driven from the view layer
            // (CustomProvidersSection) via LlmIdeAPIClient.syncCustomProviders,
            // which injects the Bearer token.
            return true
        } catch {
            customProviderLogger.error("Encoding \(defaultsKey, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    @discardableResult
    func save(to defaults: UserDefaults = .standard) -> Bool {
        // WHY readStored: the refusal needs no backup, and load() would write a
        // stash file into the real Application Support on every refused call.
        guard case .loaded(var all) = CustomProvider.readStored(from: defaults).outcome else { return false }
        if let idx = all.firstIndex(where: { $0.id == id }) {
            all[idx] = self
        } else {
            all.append(self)
        }
        return CustomProvider.saveAll(all, to: defaults)
    }

    @discardableResult
    func delete(from defaults: UserDefaults = .standard) -> Bool {
        guard case .loaded(var all) = CustomProvider.readStored(from: defaults).outcome else { return false }
        all.removeAll { $0.id == id }
        return CustomProvider.saveAll(all, to: defaults)
    }

    /// Push every locally-persisted provider into the backend registry
    /// (POST /kb/custom-providers), which replaces this user's list there.
    /// The server persists it per user, so this Mac's list is the source of
    /// truth: an EMPTY list is sent too — skipping it would leave the last
    /// deleted provider registered on the server forever.
    ///
    /// Fire-and-forget; failures are logged. Prefer `syncAllToBackendThrowing`
    /// where the caller can show the error.
    static func syncAllToBackend(api: LlmIdeAPIClient) {
        Task {
            do {
                try await syncAllToBackendThrowing(api: api)
            } catch {
                customProviderLogger.error("Custom provider sync failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Why a sync was refused before anything was sent.
    enum SyncError: Error {
        /// The stored list exists but could not be decoded; pushing "empty"
        /// would make the server delete the user's registry.
        case localListUnreadable
    }

    /// Like `syncAllToBackend`, but awaitable and throwing: refuses to push
    /// when the local list failed to decode, and rethrows the push error.
    static func syncAllToBackendThrowing(api: LlmIdeAPIClient) async throws {
        guard case .loaded(let all) = load() else { throw SyncError.localListUnreadable }
        try await api.syncCustomProviders(all)
    }
}
