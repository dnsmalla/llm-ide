import Foundation

/// Pure rules for the catalog part of the composer's model menu (asserted by the lab and the tests).
enum ComposerCatalog {
    static let routerOffNote = "Turn on the session router in Settings, Providers, to use these models."
    static let providerChatOffNote = "Turn on tool-capable chat for other providers in Settings, Providers."
    static let classicChatNote = "This chat uses the classic engine. Start a new chat to use these models."

    /// Why a catalog section cannot be picked right now, or nil when it can.
    static func unavailableNote(routerOn: Bool, providerChatEnabled: Bool) -> String? {
        if !routerOn { return routerOffNote }
        if !providerChatEnabled { return providerChatOffNote }
        return nil
    }

    /// The badge after a model's name: "tools" or "no tools".
    static func badge(toolsSupported: Bool) -> String { toolsSupported ? "tools" : "no tools" }

    /// A model's menu title; a catalog model carries its "tools" badge.
    static func modelMenuTitle(_ model: AIModel, in section: ComposerProviderSection) -> String {
        guard section.catalog, let tools = section.toolsByModel[model.id] else { return model.displayName }
        return "\(model.displayName)  (\(badge(toolsSupported: tools)))"
    }

    /// What a model with no tools can do: plan, execute and review need tools, so the server refuses them.
    static let noToolsHelp = "No tools: ask and document modes only. Plan, execute and review need a model with tools."

    /// Menu sections, one per enabled connection with models.
    static func sections(_ connections: [CatalogConnectionSummary], routerOn: Bool, providerChatEnabled: Bool) -> [ComposerProviderSection] {
        let note = unavailableNote(routerOn: routerOn, providerChatEnabled: providerChatEnabled)
        return connections.compactMap { c in
            guard !c.models.isEmpty else { return nil }
            return ComposerProviderSection(
                id: c.wireId, title: c.name,
                models: c.models.map { AIModel(id: $0.id, displayName: $0.id) },
                runsOnAgentEngine: note == nil,
                catalog: true,
                toolsByModel: Dictionary(c.models.map { ($0.id, $0.toolsSupported) }, uniquingKeysWith: { a, _ in a }),
                unavailableNote: note)
        }
    }

    /// The route pin a composer pick implies: a catalog model pins its provider and model; any other pick
    /// releases a pin that points at a catalog provider (so a stale pin cannot override the new pick).
    /// nil = leave the route alone.
    enum PinAction: Equatable { case pin(provider: String, model: String), unpin }
    static func pinAction(pickedProvider: String, pickedModel: String, currentPinnedProvider: String?) -> PinAction? {
        if pickedProvider.hasPrefix("custom:cat-") { return .pin(provider: pickedProvider, model: pickedModel) }
        if let pinned = currentPinnedProvider, pinned.hasPrefix("custom:cat-") { return .unpin }
        return nil
    }
}
