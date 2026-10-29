import Foundation
import SwiftUI

/// The calls the Providers card makes. `LlmIdeAPIClient` conforms; tests
/// substitute a fake so the card's state changes are checked without a server.
protocol ProviderCatalogAPI: AnyObject {
    func fetchProviderCatalog() async throws -> LlmIdeAPIClient.CatalogResponse
    func connectCatalogProvider(catalogId: String, apiKey: String?, baseURL: String?, slug: String?,
                                name: String?, allowPrivate: Bool?) async throws -> LlmIdeAPIClient.CatalogConnection
    func disconnectCatalogProvider(id: String) async throws -> Bool
    func testCatalogProvider(id: String) async throws -> LlmIdeAPIClient.CatalogTestResult
    func fetchCatalogModels(id: String, refresh: Bool) async throws -> LlmIdeAPIClient.CatalogModelList
    func saveProviderCatalogSettings(_ settings: LlmIdeAPIClient.CatalogSettings) async throws -> LlmIdeAPIClient.CatalogSettings
}

extension LlmIdeAPIClient: ProviderCatalogAPI {}

/// Pure rules behind the card: the words it shows and how the fallback order moves.
enum ProviderCatalogRules {
    /// "tools" badge text for a model; nil when the model has no tools (no badge).
    static func toolsBadge(_ model: LlmIdeAPIClient.CatalogModel) -> String? {
        guard model.toolsSupported else { return nil }
        switch model.toolsSource {
        case "inferred": return "tools (guessed)"
        case "override": return "tools (yours)"
        default: return "tools"
        }
    }

    /// One line under a model with no tools, so the user knows why a tool mode refuses it.
    static func noToolsHint(_ model: LlmIdeAPIClient.CatalogModel) -> String? {
        model.toolsSupported ? nil : "No tool support known. Plan, Assist-plan, Review and Execute need tools."
    }

    static func contextText(_ model: LlmIdeAPIClient.CatalogModel) -> String? {
        guard let w = model.contextWindow, w > 0 else { return nil }
        return w >= 1_000_000 ? String(format: "%.1fM ctx", Double(w) / 1_000_000) : "\(w / 1000)k ctx"
    }

    /// A server refusal's message, else the error's own text. Never contains a key:
    /// the server redacts it, and this never echoes the request.
    static func failure(_ error: Error) -> String {
        if let api = error as? APIError, case let .http(_, _, message, _) = api { return message }
        return error.localizedDescription
    }

    /// Fallback order after moving `entry` one place up (-1) or down (+1).
    static func moved(_ order: [LlmIdeAPIClient.CatalogFallbackEntry], _ entry: LlmIdeAPIClient.CatalogFallbackEntry,
                      by delta: Int) -> [LlmIdeAPIClient.CatalogFallbackEntry] {
        guard let i = order.firstIndex(of: entry) else { return order }
        let j = i + delta
        guard order.indices.contains(j) else { return order }
        var out = order
        out.swapAt(i, j)
        return out
    }

    /// The fallback list as it should be saved: only connected providers, in order, no duplicates.
    static func pruned(_ order: [LlmIdeAPIClient.CatalogFallbackEntry],
                       connected: Set<String>) -> [LlmIdeAPIClient.CatalogFallbackEntry] {
        var seen = Set<String>()
        return order.filter { connected.contains($0.provider) && seen.insert($0.provider).inserted }
    }
}

/// State of the Settings → Provider catalog card.
@MainActor
final class ProviderCatalogModel: ObservableObject {
    @Published private(set) var providers: [LlmIdeAPIClient.CatalogProvider] = []
    @Published private(set) var settings = LlmIdeAPIClient.CatalogSettings()
    @Published private(set) var loadError: String?
    @Published private(set) var isLoading = false
    /// Per connection id: the last test result line.
    @Published private(set) var testResults: [String: (ok: Bool, text: String)] = [:]
    /// Per connection id: the model list once opened.
    @Published private(set) var modelLists: [String: LlmIdeAPIClient.CatalogModelList] = [:]
    @Published private(set) var busy: Set<String> = []
    @Published var actionError: String?

    private let api: ProviderCatalogAPI

    init(api: ProviderCatalogAPI) { self.api = api }

    var connections: [LlmIdeAPIClient.CatalogConnection] { providers.flatMap(\.connections) }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let r = try await api.fetchProviderCatalog()
            providers = r.providers
            settings = r.settings
            loadError = nil
        } catch {
            loadError = ProviderCatalogRules.failure(error)
        }
    }

    /// Connect (or update) a provider. The key goes to the server once and is not kept here.
    @discardableResult
    func connect(catalogId: String, apiKey: String?, baseURL: String? = nil, slug: String? = nil,
                 name: String? = nil, allowPrivate: Bool? = nil) async -> Bool {
        busy.insert(catalogId)
        defer { busy.remove(catalogId) }
        do {
            let key = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await api.connectCatalogProvider(catalogId: catalogId, apiKey: (key?.isEmpty == false) ? key : nil,
                                                     baseURL: baseURL, slug: slug, name: name,
                                                     allowPrivate: allowPrivate)
            actionError = nil
            await load()
            return true
        } catch {
            actionError = ProviderCatalogRules.failure(error)
            return false
        }
    }

    func disconnect(_ connection: LlmIdeAPIClient.CatalogConnection) async {
        busy.insert(connection.id)
        defer { busy.remove(connection.id) }
        do {
            _ = try await api.disconnectCatalogProvider(id: connection.id)
            testResults[connection.id] = nil
            modelLists[connection.id] = nil
            actionError = nil
            await load()
        } catch {
            actionError = ProviderCatalogRules.failure(error)
        }
    }

    func test(_ connection: LlmIdeAPIClient.CatalogConnection) async {
        busy.insert(connection.id)
        defer { busy.remove(connection.id) }
        do {
            let r = try await api.testCatalogProvider(id: connection.id)
            testResults[connection.id] = (r.ok, r.detail)
        } catch {
            testResults[connection.id] = (false, ProviderCatalogRules.failure(error))
        }
    }

    func loadModels(_ connection: LlmIdeAPIClient.CatalogConnection, refresh: Bool = false) async {
        busy.insert(connection.id)
        defer { busy.remove(connection.id) }
        do {
            modelLists[connection.id] = try await api.fetchCatalogModels(id: connection.id, refresh: refresh)
        } catch {
            actionError = ProviderCatalogRules.failure(error)
        }
    }

    /// Save a settings change; the server's answer is what the card then shows.
    func update(_ change: (inout LlmIdeAPIClient.CatalogSettings) -> Void) async {
        var next = settings
        change(&next)
        next.fallbackOrder = ProviderCatalogRules.pruned(next.fallbackOrder, connected: Set(connections.map(\.provider)))
        do {
            settings = try await api.saveProviderCatalogSettings(next)
            actionError = nil
        } catch {
            actionError = ProviderCatalogRules.failure(error)
        }
    }

    func setToolOverride(_ connection: LlmIdeAPIClient.CatalogConnection, model: String, to value: Bool?) async {
        let key = "\(connection.id)/\(model)"
        await update { s in
            if let value { s.toolOverrides[key] = value } else { s.toolOverrides[key] = nil }
        }
        await loadModels(connection, refresh: false)
    }

    func inFallback(_ connection: LlmIdeAPIClient.CatalogConnection) -> Bool {
        settings.fallbackOrder.contains { $0.provider == connection.provider }
    }

    func setInFallback(_ connection: LlmIdeAPIClient.CatalogConnection, _ on: Bool) async {
        await update { s in
            s.fallbackOrder.removeAll { $0.provider == connection.provider }
            if on { s.fallbackOrder.append(.init(provider: connection.provider)) }
        }
    }

    func move(_ entry: LlmIdeAPIClient.CatalogFallbackEntry, by delta: Int) async {
        await update { $0.fallbackOrder = ProviderCatalogRules.moved($0.fallbackOrder, entry, by: delta) }
    }

    func name(forProvider provider: String) -> String {
        connections.first { $0.provider == provider }?.name ?? provider
    }
}
