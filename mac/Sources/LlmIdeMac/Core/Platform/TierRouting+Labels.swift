import Foundation

// The Settings wording for tiers and roles, kept out of TierRouting.swift
// (GRID 500-line file rule) so the routing model stays readable.
extension RoutingTier {
    var displayName: String {
        switch self {
        case .strong:   return "Strong"
        case .standard: return "Standard"
        case .cheap:    return "Cheap"
        case .image:    return "Image"
        }
    }
}

extension RoutedFeature {
    var displayName: String {
        switch self {
        case .subagents:       return "Plugin subagents"
        case .loop:            return "Loop (agent steps, regression replay)"
        case .autoTasks:       return "Auto Tasks"
        case .quickChat:       return "Quick chat & phone"
        case .pipeline:        return "Server pipeline (plan, codegen)"
        case .internal:        return "Internal helpers (summaries, classify)"
        case .decisions:       return "Decisions"
        case .chatPlanning:    return "Chat · Planning"
        case .chatCoding:      return "Chat · Coding"
        case .chatReviewing:   return "Chat · Reviewing"
        case .chatDocuments:   return "Chat · Documents"
        case .imageGeneration: return "Image generation"
        }
    }

    /// What this role runs when no tier is chosen. Mac roles run Standard
    /// (`activeCLI` / `defaultModelId`, which Standard's write-through keeps
    /// equal to a built-in Standard; a custom Standard's route for Background
    /// roles); server roles keep the server's own default (e.g. summaries stay
    /// on their cheap built-in model); a Media role runs nothing.
    public var unsetLabel: String {
        switch group {
        case .server:            return "Built-in default"
        case .media:             return "Not set"
        case .chat, .background: return "Standard"
        }
    }
}
