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
    ///
    /// GLM is deliberately absent. It has no built-in backend route — no
    /// adapter, no base URL, and `resolveProvider` sends `glm-*` ids to a
    /// provider that fails loudly — because it is reached as a named Custom
    /// Provider (Z.AI, base URL https://api.z.ai/api/paas/v4), which arrives
    /// on the wire as `custom:<uuid>`. Listing it here offered a selection
    /// that silently answered as Claude.
    ///
    /// The list itself lives in `ProviderCatalog`, which also builds the
    /// Settings credential rows and the usage-limits picker — one edit adds a
    /// provider to all three instead of one of them.
    static var selectable: [AICliTool] { ProviderCatalog.selectableTools }

    /// Backend provider id this tool's models route to.
    var provider: String {
        switch self {
        case .claudeCode:            return ClaudeCLI.provider
        case .openai, .copilot:      return "openai"
        case .gemini:                return "google"
        case .deepseek:              return "deepseek"
        case .glm:                   return "glm"
        case .custom:                return "custom"
        case .cursor:                return ClaudeCLI.provider // mixed; not selectable
        }
    }

    /// Vault key for this provider's API credential (nil for non-providers).
    var vaultKey: String? {
        switch provider {
        case ClaudeCLI.provider: return ClaudeCLI.vaultKey
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

    var models: [AIModel] {
        switch self {
        // These lists are FALLBACKS. Once a provider has a key, the composer
        // replaces them with the live `/models` result (see `modelsFor`), so
        // they only have to be right enough to pick from before a key exists —
        // and, critically, the FIRST entry is `defaultModelId`, the id sent
        // when nothing has been chosen. That is why retired ids here were not
        // harmless: they were the default.
        case .claudeCode:
            // Claude model ids live in the linker (ClaudeLink/ClaudeCLI.swift)
            // so a model-line refresh is a linker-only edit.
            return ClaudeCLI.fallbackModels
        case .openai:
            return [
                AIModel(id: "gpt-5.6-sol",                displayName: "GPT-5.6 Sol"),
                AIModel(id: "gpt-5.6-terra",              displayName: "GPT-5.6 Terra"),
                AIModel(id: "gpt-5.6-luna",               displayName: "GPT-5.6 Luna"),
                AIModel(id: "gpt-5.5",                    displayName: "GPT-5.5"),
                AIModel(id: "gpt-5.4-mini",               displayName: "GPT-5.4 mini"),
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
            // Gemini 2.0 flash / flash-lite were shut down (2026-06-01) and
            // 1.5 before them, so every id previously listed here was dead.
            return [
                AIModel(id: "gemini-3.6-flash",           displayName: "Gemini 3.6 Flash"),
                AIModel(id: "gemini-3.5-flash",           displayName: "Gemini 3.5 Flash"),
                AIModel(id: "gemini-3.1-flash-lite",      displayName: "Gemini 3.1 Flash-Lite"),
            ]
        case .deepseek:
            return [
                AIModel(id: "deepseek-chat",              displayName: "DeepSeek Chat"),
                AIModel(id: "deepseek-reasoner",          displayName: "DeepSeek Reasoner"),
            ]
        case .glm:
            // Not selectable (see `selectable`) — GLM is configured as a named
            // Custom Provider, which carries its own model list. The old
            // hardcoded ids here (glm-4-plus, glm-3.5-turbo) were retired
            // upstream anyway; Z.AI's current line is glm-5.2 / glm-5-turbo /
            // glm-4.7, entered per-provider in Settings → Custom Providers.
            return []
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
        case .claudeCode: return ClaudeCLI.executable
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
    /// Claude's permission mode is separate (`unattendedPermissionArgs`) —
    /// callers prepend it before these args.
    ///
    /// Trade-off: non-Claude unattended modes are broader than Claude's
    /// `acceptEdits` — Codex `--yolo` (= `--dangerously-bypass-approvals-and-
    /// sandbox`, also disables its sandbox) and Gemini `--yolo` auto-approve
    /// ALL tool calls. Selecting a non-Claude CLI for auto tasks opts into
    /// that broader permission surface.
    func nonInteractivePromptArgs(_ prompt: String) -> [String]? {
        switch self {
        case .claudeCode:      return ClaudeCLI.promptArgs(prompt)
        case .openai:          return ["exec", "--yolo", prompt]   // codex exec --yolo <prompt>
        case .gemini:          return ["--yolo", "-p", prompt]     // --yolo auto-approves; -p passes the prompt
        case .copilot, .cursor: return nil                        // interactive editors — not suited to unattended auto tasks
        case .deepseek, .glm, .custom: return nil                 // no CLI executable (caller early-returns before this)
        }
    }

    /// Whether this tool can run unattended at all — callers should check
    /// this BEFORE any side effects (log files, start records), not only at
    /// the moment they build the prompt args.
    var supportsUnattendedRuns: Bool { nonInteractivePromptArgs("") != nil }

    /// Permission-mode args for unattended runs, prepended before
    /// `nonInteractivePromptArgs` by every CLI-spawning caller. Only Claude
    /// separates permission mode from its prompt args (the other CLIs bundle
    /// auto-approval into theirs), so this is empty everywhere else.
    var unattendedPermissionArgs: [String] {
        switch self {
        case .claudeCode: return ClaudeCLI.unattendedPermissionArgs
        default:          return []
        }
    }
}

struct AIModel: Identifiable, Hashable, Codable {
    let id: String
    let displayName: String
}
