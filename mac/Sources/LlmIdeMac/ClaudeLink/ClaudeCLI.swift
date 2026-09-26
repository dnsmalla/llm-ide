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

    // No hardcoded Claude model list or retired-id table here. Claude's
    // models — ids, names and the default — come only from the account's live
    // list (the Agent SDK's, via the backend; see `LiveModelCache`). Before
    // the first fetch the list is empty, no model id is sent, and the SDK
    // runs the account's default.
}
