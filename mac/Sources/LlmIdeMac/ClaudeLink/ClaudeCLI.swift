import Foundation

/// Part of the Claude linker (see `docs/explanation/claude-linker.md`):
/// everything the Mac app knows about invoking the `claude` CLI and about
/// Anthropic's identifier vocabulary. Auto Tasks and the Code Workflow
/// spawn the CLI through `AICliTool`, which delegates its Claude entries
/// here — so a CLI release that renames a flag or retires a model id is
/// absorbed in this file.
enum ClaudeCLI {

    /// The executable name used to invoke the CLI from the command line.
    static let executable = "claude"

    /// Backend provider id Claude models route to (`AICliTool.provider`,
    /// `AgentV2Selection.anthropicProvider`).
    static let provider = "anthropic"

    /// Vault key for the per-user Anthropic API credential.
    static let vaultKey = "claude.apiKey"

    /// Non-interactive prompt args (`claude -p <prompt>`); unattended runs
    /// add `unattendedPermissionArgs` separately.
    static func promptArgs(_ prompt: String) -> [String] { ["-p", prompt] }

    /// Unattended permission mode for headless runs: `acceptEdits` lets the
    /// CLI edit files without an interactive prompt (there is no stdin to
    /// feed one) while still refusing broader actions — deliberately
    /// narrower than other CLIs' `--yolo`-style modes.
    static let unattendedPermissionArgs = ["--permission-mode", "acceptEdits"]

    /// Fallback model list shown before a key exists. Once a provider has a
    /// key, the composer replaces this with the live `/models` result — so it
    /// only has to be right enough to pick from, and critically the FIRST
    /// entry is the default id sent when nothing has been chosen. Ids carry
    /// no date suffix — the undated id tracks the current snapshot.
    static let fallbackModels: [AIModel] = [
        AIModel(id: "claude-opus-5",    displayName: "Opus 5"),
        AIModel(id: "claude-sonnet-5",  displayName: "Sonnet 5"),
        AIModel(id: "claude-haiku-4-5", displayName: "Haiku 4.5"),
        AIModel(id: "claude-fable-5",   displayName: "Fable 5"),
        AIModel(id: "claude-opus-4-8",  displayName: "Opus 4.8"),
    ]

    /// Retired Claude model ids → their same-family successor (merged into
    /// `AppConfig.retiredModelIds`). When `fallbackModels` drops an id, add
    /// the retiring id here in the SAME edit — otherwise a user's persisted
    /// choice coerces to the Claude default instead of its family successor.
    static let retiredModelIds: [String: String] = [
        "claude-opus-4-7": "claude-opus-4-8",
        "claude-sonnet-4-6": "claude-sonnet-5",
        "claude-haiku-4-5-20251001": "claude-haiku-4-5",   // date-suffixed form
    ]
}
