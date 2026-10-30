import Foundation

/// Pure rules for the catalog part of the composer's model menu (asserted by the lab and the tests).
enum ComposerCatalog {
    static let routerOffNote = "Chat on these models needs the session router, which is off."
    /// The router is switched on in Settings but the running backend has not restarted with it yet.
    static let routerPendingNote = ProviderMigrationText.routerPending
    /// Shown (not blocking) on a catalog section while tools on provider models are off.
    static let toolsOffNote = "Tools on provider models are off: these models answer in ask and document modes only."
    static let toolsSwitchLabel = ProviderMigrationText.toolsSwitchLabel
    static let toolsExplanation = ProviderMigrationText.toolsExplanation
    static let unsupportedNote = "Chat on this provider is not supported any more. Connect it in Settings, Providers (the catalog), or use a Claude model."

    /// Why a catalog section cannot be picked right now, or nil when it can.
    static func unavailableNote(routerOn: Bool, providerChatEnabled: Bool, routerPrefOn: Bool = false) -> String? {
        if !routerOn { return routerPrefOn ? routerPendingNote : routerOffNote }
        return nil
    }

    /// The badge after a model's name: "tools" or "no tools".
    static func badge(toolsSupported: Bool) -> String { toolsSupported ? "tools" : "no tools" }

    /// The inline action a section's note offers: with the router off, one click enables it (a Settings
    /// preference, applied at the next backend start; never switched on silently).
    static func offersRouterSwitch(_ section: ComposerProviderSection) -> Bool {
        section.catalog && section.unavailableNote == routerOffNote
    }

    /// What the action says it does.
    static let routerSwitchLabel = "Turn on the session router (applies at next backend start)"

    /// A model's menu title; a catalog model carries its "tools" badge.
    static func modelMenuTitle(_ model: AIModel, in section: ComposerProviderSection) -> String {
        guard section.catalog, let tools = section.toolsByModel[model.id] else { return model.displayName }
        return "\(model.displayName)  (\(badge(toolsSupported: tools)))"
    }

    /// Why a turn on the selected model will run as plain chat (no tools), or nil when it will not.
    enum PlainChatReason: Equatable { case toolsOff, modelLacksTools }

    /// Modes that ask for tools (`auto` may resolve to one of them).
    static let toolModes: Set<String> = ["auto", "execute", "plan", "assist_plan", "review"]

    /// The inline "Plain chat (no tools)" note: a catalog model in a tool mode with tools switched off, or on a
    /// model the catalog does not list as tool-capable. Claude and non-catalog providers never show it.
    static func plainChatReason(provider: String, model: String, mode: String,
                                connections: [CatalogConnectionSummary], toolsEnabled: Bool) -> PlainChatReason? {
        guard provider.hasPrefix("custom:cat-"), toolModes.contains(mode) else { return nil }
        if !toolsEnabled { return .toolsOff }
        let listed = connections.first { $0.wireId == provider }?.models.first { $0.id == model }
        return listed?.toolsSupported == true ? nil : .modelLacksTools
    }

    static let plainChatTitle = "Plain chat (no tools)"
    static func plainChatDetail(_ reason: PlainChatReason) -> String {
        switch reason {
        case .toolsOff: return "Tools are off for provider models, so this model answers without reading files or running commands."
        case .modelLacksTools: return "This model is not known to support tools. Pick one with the tools badge for edits and commands."
        }
    }
    static let allowToolsLabel = "Allow tools"

    /// The one compact row at the bottom of the menu while no catalog provider is connected.
    static let moreProvidersHint = "More providers: Settings → Providers"

    /// What a model with no tools can do: plan, execute and review need tools, so the server refuses them.
    static let noToolsHelp = "No tools: ask and document modes only. Plan, execute and review need a model with tools."

    /// Menu sections, one per enabled connection with models.
    static func sections(_ connections: [CatalogConnectionSummary], routerOn: Bool, providerChatEnabled: Bool,
                         routerPrefOn: Bool = false) -> [ComposerProviderSection] {
        let note = unavailableNote(routerOn: routerOn, providerChatEnabled: providerChatEnabled, routerPrefOn: routerPrefOn)
        return connections.compactMap { c in
            guard !c.models.isEmpty else { return nil }
            return ComposerProviderSection(
                id: c.wireId, title: c.name,
                models: c.models.map { AIModel(id: $0.id, displayName: $0.id) },
                runsOnAgentEngine: note == nil,
                catalog: true,
                toolsByModel: Dictionary(c.models.map { ($0.id, $0.toolsSupported) }, uniquingKeysWith: { a, _ in a }),
                unavailableNote: note,
                infoNote: providerChatEnabled ? nil : toolsOffNote)
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
