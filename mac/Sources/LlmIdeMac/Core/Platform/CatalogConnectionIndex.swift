import Foundation

/// A provider-catalog connection as the app sees it (the composer's model menu, the tier pickers): the wire id a turn is sent
/// under (`custom:cat-…`), a name, and its models with the server's "tools supported" flag.
struct CatalogConnectionSummary: Equatable, Sendable {
    let wireId: String
    let name: String
    let models: [LlmIdeAPIClient.CatalogModel]
}

/// The wire ids of the catalog connections the chat may run on, shared between the model menu and the
/// engine-selection rule (`AgentV2Selection.liveAgentCapableProviders`). A connection counts only
/// while the session router is on AND the user turned on tool-capable chat for other providers: the
/// turn is answered by the adapter behind the router, so without both it would be refused.
final class CatalogConnectionIndex: @unchecked Sendable {
    static let shared = CatalogConnectionIndex()
    private let lock = NSLock()
    private var ids: Set<String> = []
    private var all: [CatalogConnectionSummary] = []
    private var providerChatOn = false
    private var loaded = false

    func update(connections: [CatalogConnectionSummary], providerChatEnabled: Bool) {
        lock.lock(); defer { lock.unlock() }
        all = connections
        loaded = true
        ids = Set(connections.map(\.wireId))
        providerChatOn = providerChatEnabled
    }

    /// Every enabled connection last loaded, with its models.
    var connections: [CatalogConnectionSummary] {
        lock.lock(); defer { lock.unlock() }
        return all
    }

    func models(for wireId: String) -> [AIModel] {
        lock.lock(); defer { lock.unlock() }
        return (all.first { $0.wireId == wireId }?.models ?? []).map { AIModel(id: $0.id, displayName: $0.id) }
    }

    /// Wire ids the Agent engine may run right now. Empty with the router off.
    func capableWireIds(routerOn: Bool = ChatRoutePreference.routerEnabled()) -> Set<String> {
        lock.lock(); defer { lock.unlock() }
        return routerOn && providerChatOn ? ids : []
    }

    /// False until the catalog has been fetched once in this launch.
    var isLoaded: Bool {
        lock.lock(); defer { lock.unlock() }
        return loaded
    }

    var providerChatEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return providerChatOn
    }

    func knows(_ wireId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return ids.contains(wireId)
    }
}

