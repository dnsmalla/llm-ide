import Foundation

/// Represents an AI CLI tool the user can select as their active assistant.
/// Each tool exposes a set of available models; the selection is persisted
/// in AppConfig and drives the model picker in CodeAssistantPanel.
enum AICliTool: String, CaseIterable, Identifiable {
    case claudeCode = "claude_code"
    case cursor     = "cursor"
    case copilot    = "copilot"
    case gemini     = "gemini"

    var id: String { rawValue }

    /// Tools that are actually functional end-to-end. The backend only
    /// speaks to the Claude CLI / Anthropic API today, so the others are
    /// hidden from the picker — showing them would silently run Claude
    /// under another tool's name. Add cases here when real support lands.
    static var selectable: [AICliTool] { [.claudeCode] }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .cursor:     return "Cursor"
        case .copilot:    return "GitHub Copilot"
        case .gemini:     return "Gemini CLI"
        }
    }

    var icon: String {
        switch self {
        case .claudeCode: return "terminal.fill"
        case .cursor:     return "curlybraces.square.fill"
        case .copilot:    return "chevron.left.forwardslash.chevron.right"
        case .gemini:     return "sparkles"
        }
    }

    var description: String {
        switch self {
        case .claudeCode: return "Anthropic's official CLI for Claude"
        case .cursor:     return "AI-first code editor by Anysphere"
        case .copilot:    return "GitHub's AI coding assistant"
        case .gemini:     return "Google's Gemini AI CLI"
        }
    }

    var models: [AIModel] {
        switch self {
        case .claudeCode:
            return [
                AIModel(id: "claude-sonnet-4-6",         displayName: "Sonnet 4.6"),
                AIModel(id: "claude-opus-4-8",            displayName: "Opus 4.8"),
                AIModel(id: "claude-haiku-4-5-20251001",  displayName: "Haiku 4.5"),
            ]
        case .cursor:
            return [
                AIModel(id: "claude-3-5-sonnet-20241022", displayName: "claude-3.5-sonnet"),
                AIModel(id: "gpt-4o",                     displayName: "GPT-4o"),
                AIModel(id: "gpt-4o-mini",                displayName: "GPT-4o mini"),
                AIModel(id: "o1-mini",                    displayName: "o1-mini"),
            ]
        case .copilot:
            return [
                AIModel(id: "gpt-4o",                     displayName: "GPT-4o"),
                AIModel(id: "o1-preview",                 displayName: "o1-preview"),
                AIModel(id: "o1-mini",                    displayName: "o1-mini"),
                AIModel(id: "claude-3-5-sonnet-20241022", displayName: "claude-3.5-sonnet"),
            ]
        case .gemini:
            return [
                AIModel(id: "gemini-2.0-flash",           displayName: "Gemini 2.0 Flash"),
                AIModel(id: "gemini-1.5-pro",             displayName: "Gemini 1.5 Pro"),
                AIModel(id: "gemini-1.5-flash",           displayName: "Gemini 1.5 Flash"),
            ]
        }
    }

    var defaultModelId: String { models[0].id }

    /// The executable name used to invoke this tool from the command line.
    var cliExecutable: String {
        switch self {
        case .claudeCode: return "claude"
        case .cursor:     return "cursor"
        case .copilot:    return "gh copilot"
        case .gemini:     return "gemini"
        }
    }
}

struct AIModel: Identifiable, Hashable {
    let id: String
    let displayName: String
}
