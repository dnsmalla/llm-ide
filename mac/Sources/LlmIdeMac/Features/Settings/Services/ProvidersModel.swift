import Foundation
import Combine

/// The calls the Providers section makes beyond the catalog's own (`ProviderCatalogAPI`): the vault, key
/// verification and the custom-provider registry. `LlmIdeAPIClient` conforms; tests substitute a recording fake
/// so edit routing (which store a change goes to) is asserted without a server.
protocol ProviderListAPI: ProviderCatalogAPI {
    func connectCatalogProvider(_ request: LlmIdeAPIClient.CatalogConnectRequest) async throws -> LlmIdeAPIClient.CatalogConnection
    func configuredSecretKeys() async throws -> Set<String>
    func setSecret(key: String, value: String) async throws
    func verifyProvider(_ provider: String, mode: String, apiKey: String?,
                        baseUrl: String?) async throws -> LlmIdeAPIClient.ProviderVerifyResult
    func syncCustomProviders(_ providers: [CustomProvider], timeout: TimeInterval?) async throws
}

extension LlmIdeAPIClient: ProviderListAPI {}

/// Settings → Providers: the one list. Reads the catalog (server), the custom-provider list (this Mac) and
/// the vault key listing, folds them with `ProviderRowBuilder`, and routes every edit to the store that owns
/// the row. Nothing here deletes a legacy entry the user did not ask to remove, and no key is ever kept:
/// a key goes to the server once and the field that held it is cleared by the caller.
@MainActor
final class ProvidersModel: ObservableObject {
    /// The catalog half (connections, models, settings). Shared with the Model routing card so the two never
    /// hold different snapshots of the same settings.
    let catalog: ProviderCatalogModel

    @Published private(set) var custom: [CustomProvider] = []
    @Published private(set) var configuredKeys: Set<String>?
    @Published private(set) var isListUnreadable = false
    /// Last result line per row id: a test verdict, a "moved" note, a save error. Never contains a key.
    @Published private(set) var messages: [String: (ok: Bool, text: String)] = [:]
    @Published private(set) var busy: Set<String> = []
    @Published var cliReady: [String: Bool] = [:]
    @Published var sharedBaseURL = ""
    @Published var actionError: String?

    private let api: ProviderListAPI
    private let defaults: UserDefaults
    private let builtIns: () -> [ProviderCatalog.Entry]
    private let probe: (URL, String?) async -> (ok: Bool, text: String)
    /// Publishes the connections to the composer / tier pickers after a catalog change (the real client's
    /// `refreshCatalogConnectionIndex`); a no-op in tests.
    private let indexRefresh: () async -> Void
    private var bag = Set<AnyCancellable>()

    init(api: ProviderListAPI, catalog: ProviderCatalogModel, defaults: UserDefaults = .standard,
         builtIns: @escaping () -> [ProviderCatalog.Entry] = { ProviderCatalog.all },
         probe: @escaping (URL, String?) async -> (ok: Bool, text: String) = ProvidersModel.liveProbe,
         indexRefresh: @escaping () async -> Void = {}) {
        self.api = api
        self.indexRefresh = indexRefresh
        self.catalog = catalog
        self.defaults = defaults
        self.builtIns = builtIns
        self.probe = probe
        sharedBaseURL = defaults.string(forKey: Self.sharedBaseURLHintKey) ?? ""
        // One observed object is enough for the view: a catalog change re-renders the list too.
        catalog.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
        refreshCustom()
    }

    // MARK: - Rows

    var rows: [ProviderRow] {
        ProviderRowBuilder.rows(ProviderListInput(
            catalogProviders: catalog.providers,
            catalogKnown: catalog.hasLoaded && catalog.loadError == nil,
            custom: custom, builtIns: builtIns(), configuredKeys: configuredKeys,
            sharedBaseURL: sharedBaseURL, cliReady: cliReady))
    }

    func connection(for row: ProviderRow) -> LlmIdeAPIClient.CatalogConnection? {
        guard case .catalog(let id, _) = row.source else { return nil }
        return catalog.connections.first { $0.id == id }
    }

    func customProvider(for row: ProviderRow) -> CustomProvider? {
        guard case .custom(let id) = row.source else { return nil }
        return custom.first { $0.id == id }
    }

    // MARK: - Loading

    func refreshCustom() {
        custom = CustomProvider.loadAll(from: defaults)
        isListUnreadable = CustomProvider.isListUnreadable(in: defaults)
    }

    /// Everything the list needs. Each source fails on its own: a backend that is down leaves the Mac-side
    /// rows visible, with key status unknown rather than "missing".
    func load() async {
        refreshCustom()
        async let catalogLoad: Void = catalog.load()
        async let keys: Void = loadConfiguredKeys()
        _ = await (catalogLoad, keys)
        // The server keeps its custom-provider registry in memory; a copy for "Move to catalog" reads it.
        await syncRegistry()
    }

    func loadConfiguredKeys() async {
        configuredKeys = try? await api.configuredSecretKeys()
    }

    /// Re-push the custom list into the server registry. Refuses while the stored list is unreadable (an empty
    /// push would wipe the registry).
    func syncRegistry() async {
        guard !CustomProvider.isListUnreadable(in: defaults) else {
            isListUnreadable = true
            return
        }
        let all = CustomProvider.loadAll(from: defaults)
        do {
            try await api.syncCustomProviders(all, timeout: nil)
            if actionError?.hasPrefix("Couldn't sync") == true { actionError = nil }
        } catch {
            actionError = "Couldn't sync providers to the server: \(ProviderCatalogRules.failure(error)). They may not work until it succeeds."
        }
    }

    // MARK: - The shared custom endpoint's base URL

    /// Non-secret copy of the last saved shared-endpoint base URL (the vault is write-only, so the field could
    /// never be prefilled otherwise). The same key the old Model Providers card used.
    static let sharedBaseURLHintKey = "MEETNOTES_CUSTOM_BASE_URL_HINT"

    /// Save the shared custom endpoint's base URL (vault `custom.baseUrl`). Refuses plain http to a remote host.
    func saveSharedBaseURL(_ raw: String, row: ProviderRow) async {
        let url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { messages[row.id] = (false, "Enter a base URL (e.g. https://openrouter.ai/api/v1)."); return }
        guard !EndpointSecurity.isInsecureRemoteHTTP(url) else {
            messages[row.id] = (false, "Plain http to a non-local host would send your API key unencrypted. Use https.")
            return
        }
        await run(row) {
            try await self.api.setSecret(key: "custom.baseUrl", value: url)
            self.configuredKeys?.insert("custom.baseUrl")
            self.defaults.set(url, forKey: Self.sharedBaseURLHintKey)
            self.sharedBaseURL = url
            self.messages[row.id] = (true, "Base URL saved.")
        }
    }

    // MARK: - Enable / disable

    /// Catalog: re-saved on the server with `enabled` flipped. Custom: its own flag, then the registry sync.
    /// Built-in rows have no switch.
    func toggleEnabled(_ row: ProviderRow) async {
        switch row.source {
        case .catalog:
            guard let c = connection(for: row) else { return }
            let target = !c.enabled
            let entry = catalog.providers.first { $0.id == c.catalogId }
            await run(row) {
                let saved = try await self.api.connectCatalogProvider(
                    ProviderRowBuilder.request(updating: c, in: entry, enabled: target))
                // A server that predates `enabled` ignores it and answers enabled: true.
                if saved.enabled != target {
                    self.messages[row.id] = (false, "This backend can't switch a connection off yet. Update the backend, or remove the connection.")
                }
                await self.catalog.load()
                await self.indexRefresh()
            }
        case .custom:
            guard !isListUnreadable, var cp = customProvider(for: row) else { return }
            cp.isEnabled.toggle()
            guard cp.save(to: defaults) else {
                messages[row.id] = (false, "Couldn't save: the stored provider list is unreadable (a backup was kept).")
                return
            }
            refreshCustom()
            await syncRegistry()
        case .builtIn:
            return
        }
    }

    // MARK: - Keys

    /// Store a key on the store that owns the row. Catalog: the connection is re-saved with it. Built-in: the
    /// key is verified first (a rejected key never replaces a working one), then written to the vault. Custom:
    /// written to the provider's own vault slot. The caller clears the text field either way.
    @discardableResult
    func setKey(_ row: ProviderRow, key rawKey: String) async -> Bool {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return false }
        var ok = false
        await run(row) {
            switch row.source {
            case .catalog:
                guard let c = self.connection(for: row) else { return }
                let entry = self.catalog.providers.first { $0.id == c.catalogId }
                _ = try await self.api.connectCatalogProvider(ProviderRowBuilder.request(updating: c, in: entry, apiKey: key))
                await self.catalog.load()
                await self.indexRefresh()
                self.messages[row.id] = (true, "Key saved.")
                ok = true
            case .builtIn(let id):
                guard let e = self.builtIns().first(where: { $0.id == id }) else { return }
                if let base = row.baseURL, EndpointSecurity.isInsecureRemoteHTTP(base) {
                    self.messages[row.id] = (false, "Plain http to a non-local host would send your API key unencrypted. Use https.")
                    return
                }
                let result = try await self.api.verifyProvider(id, mode: "key", apiKey: key, baseUrl: row.baseURL)
                guard result.ok else {
                    self.messages[row.id] = (false, result.detail ?? "Verification failed. The key was not saved.")
                    return
                }
                try await self.api.setSecret(key: e.vaultKey, value: key)
                self.configuredKeys?.insert(e.vaultKey)
                self.messages[row.id] = (true, "Verified and saved.")
                ok = true
            case .custom:
                guard let cp = self.customProvider(for: row) else { return }
                if EndpointSecurity.isInsecureRemoteHTTP(cp.baseURL) {
                    self.messages[row.id] = (false, "Plain http to a non-local host would send your API key unencrypted. Use https.")
                    return
                }
                try await self.api.setSecret(key: cp.apiKey, value: key)
                self.configuredKeys?.insert(cp.apiKey)
                self.messages[row.id] = (true, "Key saved.")
                ok = true
            }
        }
        if ok { NotificationCenter.default.post(name: .providerKeysChanged, object: nil) }
        return ok
    }

    /// Clear a stored key without removing anything else (built-in rows). Catalog and custom rows are removed
    /// instead, which clears their key with them.
    func clearKey(_ row: ProviderRow) async {
        guard case .builtIn(let id) = row.source, let e = builtIns().first(where: { $0.id == id }) else { return }
        await run(row) {
            try await self.api.setSecret(key: e.vaultKey, value: "")
            self.configuredKeys?.remove(e.vaultKey)
            self.messages[row.id] = (true, "Key cleared.")
            NotificationCenter.default.post(name: .providerKeysChanged, object: nil)
        }
    }

    // MARK: - Test

    /// Catalog: the server's free models probe. Built-in: verify the stored key (or the CLI, when `cli`).
    /// Custom: probe `<base>/models` with the key typed now; the stored one cannot be read back.
    func test(_ row: ProviderRow, typedKey: String = "", cli: Bool = false) async {
        switch row.source {
        case .catalog:
            guard let c = connection(for: row) else { return }
            await catalog.test(c)
            if let r = catalog.testResults[c.id] { messages[row.id] = r }
        case .builtIn(let id):
            await run(row) {
                let result = try await self.api.verifyProvider(id, mode: cli ? "cli" : "key", apiKey: nil, baseUrl: row.baseURL)
                self.messages[row.id] = (result.ok, result.detail ?? (result.ok ? (cli ? "CLI ready" : "Key works") : "Failed"))
                if cli {
                    self.cliReady[id] = result.ok
                    ProviderCliCheckCache.results[id] = result.ok
                }
            }
        case .custom:
            guard let cp = customProvider(for: row) else { return }
            let key = typedKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if key.isEmpty, !EndpointSecurity.isLoopbackURL(cp.baseURL) {
                messages[row.id] = (false, "Enter the key to test. The stored one can't be read back.")
                return
            }
            if !key.isEmpty, EndpointSecurity.isInsecureRemoteHTTP(cp.baseURL) {
                messages[row.id] = (false, "Refusing to send the key over plain http to a non-local host. Use https.")
                return
            }
            let trimmed = cp.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            let base = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
            guard let url = URL(string: base + "/models") else {
                messages[row.id] = (false, "Invalid base URL")
                return
            }
            busy.insert(row.id)
            let r = await probe(url, key.isEmpty ? nil : key)
            busy.remove(row.id)
            messages[row.id] = r
        }
    }

    // MARK: - Remove

    /// Catalog: disconnect (the server removes the connection and its key). Custom: delete from this Mac's
    /// list, re-sync the registry and clear its vault key. Never touches a built-in's key (use `clearKey`).
    func remove(_ row: ProviderRow) async {
        switch row.source {
        case .catalog:
            guard let c = connection(for: row) else { return }
            await catalog.disconnect(c)
            messages[row.id] = nil
            await indexRefresh()
            NotificationCenter.default.post(name: .providerKeysChanged, object: nil)
        case .custom:
            guard !isListUnreadable, let cp = customProvider(for: row) else { return }
            guard cp.delete(from: defaults) else {
                actionError = "Couldn't delete: the stored provider list is unreadable (a backup was kept)."
                return
            }
            refreshCustom()
            await syncRegistry()
            if !cp.apiKey.isEmpty {
                do { try await api.setSecret(key: cp.apiKey, value: "") }
                catch {
                    actionError = "The provider was deleted, but its API key could not be removed from the vault (\(ProviderCatalogRules.failure(error))). Remove it manually."
                }
            }
            await loadConfiguredKeys()
            NotificationCenter.default.post(name: .providerKeysChanged, object: nil)
        case .builtIn:
            return
        }
    }

    // MARK: - Move to catalog

    /// Copy a legacy entry into the catalog. The server copies the key (the Mac never reads it) and the legacy
    /// entry stays untouched. A failure changes nothing.
    @discardableResult
    func moveToCatalog(_ row: ProviderRow) async -> Bool {
        guard let request = ProviderRowBuilder.moveRequest(for: row, custom: custom) else { return false }
        var ok = false
        await run(row) {
            // The registry must be current: the server resolves `custom:<id>` from it to find the key.
            await self.syncRegistry()
            _ = try await self.api.connectCatalogProvider(request)
            await self.catalog.load()
            await self.indexRefresh()
            self.messages[row.id] = (true, ProvidersText.movedNote)
            ok = true
        }
        if ok { NotificationCenter.default.post(name: .providerKeysChanged, object: nil) }
        return ok
    }

    // MARK: - Custom (Claude-compatible and legacy) providers

    /// Save a custom provider from the Add/Edit sheet. The key (when given) goes to the vault first: a failed
    /// store keeps the sheet open, so the provider is never saved without the key the user just typed.
    /// Returns an error message, or nil on success.
    func saveCustom(_ provider: CustomProvider, apiKey: String) async -> String? {
        guard !isListUnreadable else {
            return "The stored provider list is unreadable (a backup was kept), so it was left untouched."
        }
        var p = provider
        p.apiKey = "custom.\(p.id.lowercased()).apiKey"
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty {
            do { try await api.setSecret(key: p.apiKey, value: key) }
            catch { return "Couldn't store the API key: \(ProviderCatalogRules.failure(error))" }
        }
        guard p.save(to: defaults) else { return "Couldn't save the provider list." }
        refreshCustom()
        await syncRegistry()
        await loadConfiguredKeys()
        if !key.isEmpty { NotificationCenter.default.post(name: .providerKeysChanged, object: nil) }
        return nil
    }

    func discardUnreadableList() {
        if CustomProvider.discardUnreadableList(from: defaults) {
            actionError = nil
            refreshCustom()
        } else {
            actionError = "Backup could not be written. Nothing was removed."
        }
    }

    // MARK: - Helpers

    private func run(_ row: ProviderRow, _ work: @escaping () async throws -> Void) async {
        busy.insert(row.id)
        defer { busy.remove(row.id) }
        do { try await work() }
        catch { messages[row.id] = (false, ProviderCatalogRules.failure(error)) }
    }

    /// The real endpoint probe for a custom provider: GET `<base>/models` with the key as a Bearer header.
    nonisolated static func liveProbe(_ url: URL, _ key: String?) async -> (ok: Bool, text: String) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            return code == 200 ? (true, "Connected") : (false, "Server returned status \(code)")
        } catch {
            return (false, "Connection failed: \(error.localizedDescription)")
        }
    }
}

/// "Check CLI" verdicts for the life of the app process, keyed by backend provider id. The server has no
/// per-provider CLI status endpoint and the check spawns the CLI, so it only runs on a click; this keeps the
/// answer across the section view being torn down.
@MainActor
enum ProviderCliCheckCache {
    static var results: [String: Bool] = [:]
}

/// Shared URL-safety checks for provider endpoints.
enum EndpointSecurity {
    static func isLoopbackURL(_ s: String) -> Bool {
        guard let host = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines))?.host?.lowercased()
        else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    /// http (not https) to anything but a loopback host.
    static func isInsecureRemoteHTTP(_ s: String) -> Bool {
        guard let url = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "http", url.host != nil else { return false }
        return !isLoopbackURL(s)
    }
}
