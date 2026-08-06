import Foundation

/// Model/provider selection state for `CodeAssistantPanel` — independent of
/// the composer/session/streaming invariants (see
/// docs/explanation/invariants.md's "macOS Code Assistant panel" section).
@Observable
final class CodeAssistantModelState {
    var selectedModel: String = ""
    /// Current provider: either an AICliTool rawValue ("anthropic"/"openai"/...)
    /// or "custom:uuid" for a user-registered custom provider.
    var selectedProvider: String = ""
    /// Live provider models, keyed by provider id ("openai"/"google"/...).
    /// Populated from the provider's models endpoint; falls back to the
    /// built-in AICliTool.models list when empty (no key / fetch failed).
    var liveModels: [String: [AIModel]] = [:]
    /// Custom providers loaded from UserDefaults, refreshed on panel appear.
    var customProviders: [CustomProvider] = []
    var showAddModel = false
    var newModelId = ""
}
