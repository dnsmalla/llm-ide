import Foundation

/// Mirrors the server's mode strings exactly (see
/// extension/llm_agent/runtime/mode-personas.mjs / route.mjs's
/// `resolvedMode`) — raw values are wire contracts, not renameable.
enum CodeAssistMode: String, Codable, CaseIterable, Identifiable {
    case auto, plan, review, document, execute
    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .plan: return "Plan"
        // "Code Review", not "Review" — the adjacent editModeChip already
        // has its own unrelated "Review" option (file-edit confirmation
        // policy); a bare "Review" here would read as the same control.
        case .review: return "Code Review"
        case .document: return "Document"
        case .execute: return "Execute"
        }
    }

    var icon: String {
        switch self {
        case .auto: return "sparkles"
        case .plan: return "list.bullet.clipboard"
        case .review: return "checkmark.seal"
        case .document: return "doc.text"
        case .execute: return "bolt.fill"
        }
    }

    var help: String {
        switch self {
        case .auto: return "Auto — Claude classifies your request and picks a mode itself"
        case .plan: return "Plan — propose a step-by-step plan in prose; no file edits or commands"
        case .review: return "Review — give code-review feedback; no file edits or commands"
        case .document: return "Document — write documentation in the reply; no file edits or commands"
        case .execute: return "Execute — today's full agentic behavior (file edits, commands, tools)"
        }
    }
}

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
    /// User-selected mode for the NEXT turn. Defaults to `.auto` — the
    /// server classifies the request itself when this is sent as "auto".
    var selectedMode: CodeAssistMode = .auto
}
