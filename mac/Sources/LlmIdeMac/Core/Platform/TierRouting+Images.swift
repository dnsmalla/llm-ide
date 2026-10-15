import Foundation

// The image side of tier routing: the Image tier (an image model on OpenAI or
// Google) and the Image generation role, the only role that may pick it.
// Settings-only today — no feature generates images yet — so both are
// Mac-only (`TierDefaults.wireBody`) and the tier is never Standard. Split
// out of TierRouting.swift (GRID 500-line file rule), like +Decisions.
// Public so `chat-contract-lab` can assert the pure logic.
public enum ImageTierRouting {
    /// Built-in providers with an image endpoint, in menu order. Both keys
    /// are the ones Model Providers already holds — no new key.
    static let providers: [(wireId: String, tool: AICliTool)] = [
        ("openai", .openai),
        ("google", .gemini),
    ]

    public static var providerIds: [String] { providers.map(\.wireId) }

    /// The Image tier's model menu. Static on purpose: the server's live model
    /// lists filter image models OUT (providers.mjs chatModels), and no server
    /// call is made for a Mac-only tier. A saved id the list lacks is still
    /// shown by the menu (`modelChoices`), so a newer model typed elsewhere is
    /// never lost. Ids per the providers' image guides, 2026-10.
    static let models: [String: [AIModel]] = [
        "openai": [
            AIModel(id: "gpt-image-1.5",    displayName: "GPT Image 1.5"),
            AIModel(id: "gpt-image-1",      displayName: "GPT Image 1"),
            AIModel(id: "gpt-image-1-mini", displayName: "GPT Image 1 mini"),
            AIModel(id: "dall-e-3",         displayName: "DALL·E 3"),
        ],
        "google": [
            AIModel(id: "gemini-3.1-flash-image-preview", displayName: "Gemini 3.1 Flash Image (preview)"),
            AIModel(id: "gemini-3-pro-image-preview",     displayName: "Gemini 3 Pro Image (preview)"),
        ],
    ]

    static func models(forProvider provider: String) -> [AIModel] { models[provider] ?? [] }

    public static func modelIds(forProvider provider: String) -> [String] {
        models(forProvider: provider).map(\.id)
    }

    public static func isImageProvider(_ provider: String) -> Bool { models[provider] != nil }

    /// Why the Image tier (`route` = its stored entry, nil when unset) can't
    /// serve the Image generation role, or nil when it can.
    public static func unusableReason(_ route: TierRoute?) -> String? {
        guard let route else { return "the Image tier is not set" }
        if route.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "no model chosen" }
        guard isImageProvider(route.provider) else {
            return "\(providerName(route.provider)) has no image models here — choose OpenAI or Google"
        }
        return nil
    }

    static func providerName(_ provider: String) -> String {
        TierRouting.builtInProviders.first { $0.wireId == provider }?.tool.displayName ?? provider
    }

    static let roleExplanation = "no feature generates images yet — this picks the model a future image tool will use"
    static let tierNote = "only the Image generation role uses Image; it is never Standard and is not sent to the server"
}

extension RoutedFeature {
    /// Whether `tier` belongs in this role's menu: the Image tier is for the
    /// Image generation role alone, and the cost tiers for every other role.
    public func isOffered(_ tier: RoutingTier) -> Bool {
        (tier == .image) == (self == .imageGeneration)
    }
}
