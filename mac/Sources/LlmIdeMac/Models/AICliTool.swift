import Foundation

/// Represents an AI CLI tool the user can select as their active assistant.
/// Each tool exposes a set of available models; the selection is persisted
/// in AppConfig and drives the model picker in CodeAssistantPanel.
enum AICliTool: String, CaseIterable, Identifiable {
    case claudeCode = "claude_code"
    case openai     = "openai"
    case cursor     = "cursor"
    case copilot    = "copilot"
    case gemini     = "gemini"
    case deepseek   = "deepseek"
    case glm        = "glm"
    case custom     = "custom"

    var id: String { rawValue }

    /// Tools selectable in the picker. These are the direct-API providers the
    /// backend routes by model id (see extension/agents/providers.mjs):
    /// Anthropic (Claude), OpenAI, Google (Gemini). A non-Claude provider
    /// needs an API key configured in Settings → Model Providers; without one
    /// the backend returns a clear "add a key" error rather than silently
    /// running Claude. Cursor/Copilot stay hidden — they're editor tools, not
    /// direct API endpoints, so routing their gpt ids to the OpenAI API would
    /// misrepresent the source.
    static var selectable: [AICliTool] { [.claudeCode, .openai, .gemini, .deepseek, .glm, .custom] }

    /// Backend provider id this tool's models route to.
    var provider: String {
        switch self {
        case .claudeCode:            return "anthropic"
        case .openai, .copilot:      return "openai"
        case .gemini:                return "google"
        case .deepseek:              return "deepseek"
        case .glm:                   return "glm"
        case .custom:                return "custom"
        case .cursor:                return "anthropic" // mixed; not selectable
        }
    }

    /// Vault key for this provider's API credential (nil for non-providers).
    var vaultKey: String? {
        switch provider {
        case "anthropic": return "claude.apiKey"
        case "openai":    return "openai.apiKey"
        case "google":    return "google.apiKey"
        case "deepseek":  return "deepseek.apiKey"
        case "glm":       return "glm.apiKey"
        case "custom":    return "custom.apiKey"
        default:          return nil
        }
    }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude"
        case .openai:     return "OpenAI"
        case .cursor:     return "Cursor"
        case .copilot:    return "GitHub Copilot"
        case .gemini:     return "Gemini"
        case .deepseek:   return "DeepSeek"
        case .glm:        return "GLM"
        case .custom:     return "Custom"
        }
    }

    var icon: String {
        switch self {
        case .claudeCode: return "terminal.fill"
        case .openai:     return "cpu"
        case .cursor:     return "curlybraces.square.fill"
        case .copilot:    return "chevron.left.forwardslash.chevron.right"
        case .gemini:     return "sparkles"
        case .deepseek:   return "brain.head.profile"
        case .glm:        return "atom"
        case .custom:     return "network"
        }
    }

    var description: String {
        switch self {
        case .claudeCode: return "Anthropic Claude (API key, or your logged-in claude CLI)"
        case .openai:     return "OpenAI GPT / Codex models (API key)"
        case .cursor:     return "AI-first code editor by Anysphere"
        case .copilot:    return "GitHub's AI coding assistant"
        case .gemini:     return "Google Gemini models (API key)"
        case .deepseek:   return "DeepSeek Chat and Reasoner models (API key)"
        case .glm:        return "Zhipu GLM models (API key)"
        case .custom:     return "Any OpenAI-compatible endpoint (OpenRouter, Ollama, …)"
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
        case .openai:
            return [
                AIModel(id: "gpt-4o",                     displayName: "GPT-4o"),
                AIModel(id: "gpt-4o-mini",                displayName: "GPT-4o mini"),
                AIModel(id: "o3-mini",                    displayName: "o3-mini"),
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
        case .deepseek:
            return [
                AIModel(id: "deepseek-chat",              displayName: "DeepSeek Chat"),
                AIModel(id: "deepseek-reasoner",          displayName: "DeepSeek Reasoner"),
            ]
        case .glm:
            return [
                AIModel(id: "glm-4-plus",                 displayName: "GLM-4 Plus"),
                AIModel(id: "glm-4",                      displayName: "GLM-4"),
                AIModel(id: "glm-4-vision",               displayName: "GLM-4 Vision"),
                AIModel(id: "glm-3.5-turbo",              displayName: "GLM-3.5 Turbo"),
            ]
        case .custom:
            // No built-in ids — the endpoint's models come from live discovery
            // (/kb/providers/models) or "Add model…".
            return []
        }
    }

    /// First built-in model, or "" when there are none (custom). Callers that
    /// need a concrete id fall back to live/user-added models.
    var defaultModelId: String { models.first?.id ?? "" }

    /// The executable name used to invoke this tool from the command line.
    var cliExecutable: String {
        switch self {
        case .claudeCode: return "claude"
        case .openai:     return "codex"
        case .cursor:     return "cursor"
        case .copilot:    return "gh copilot"
        case .gemini:     return "gemini"
        case .deepseek:   return ""   // no CLI subscription mode
        case .glm:        return ""   // no CLI subscription mode
        case .custom:     return ""   // no CLI subscription mode
        }
    }

    /// Arguments to run this tool non-interactively with `prompt` for an
    /// unattended auto task, or nil if the tool can't run non-interactively
    /// (interactive editors like Copilot/Cursor would block on a TTY).
    ///
    /// Includes each tool's unattended/auto-approve mode so the CLI never
    /// hangs on an interactive permission prompt (there's no stdin to feed).
    /// `--permission-mode acceptEdits` for Claude is added separately by the
    /// caller (AutoCodeUpdateService.runCLI).
    ///
    /// Trade-off: non-Claude unattended modes are broader than Claude's
    /// `acceptEdits` — Codex `--yolo` (= `--dangerously-bypass-approvals-and-
    /// sandbox`, also disables its sandbox) and Gemini `--yolo` auto-approve
    /// ALL tool calls. Selecting a non-Claude CLI for auto tasks opts into
    /// that broader permission surface.
    func nonInteractivePromptArgs(_ prompt: String) -> [String]? {
        switch self {
        case .claudeCode:      return ["-p", prompt]
        case .openai:          return ["exec", "--yolo", prompt]   // codex exec --yolo <prompt>
        case .gemini:          return ["--yolo", "-p", prompt]     // --yolo auto-approves; -p passes the prompt
        case .copilot, .cursor: return nil                        // interactive editors — not suited to unattended auto tasks
        case .deepseek, .glm, .custom: return nil                 // no CLI executable (caller early-returns before this)
        }
    }
}

struct AIModel: Identifiable, Hashable, Codable {
    let id: String
    let displayName: String
}
