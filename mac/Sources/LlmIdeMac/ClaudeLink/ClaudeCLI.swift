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

    /// Default `--max-turns` for an unattended Auto Task run. An uncapped agent
    /// run that wanders through a large repo is where the tokens go.
    static let autoTaskMaxTurns = 30

    /// Extra args for a metered, capped headless run: `--output-format json`
    /// makes `claude -p` print ONE result object (text + usage) instead of the
    /// bare reply, and `--max-turns` bounds the agent loop.
    static func meteredRunArgs(maxTurns: Int = autoTaskMaxTurns) -> [String] {
        ["--output-format", "json", "--max-turns", String(maxTurns)]
    }

    /// Token counts from a `claude -p --output-format json` result's `usage`.
    struct RunUsage: Equatable {
        var inputTokens: Int
        var outputTokens: Int
        var cacheReadTokens: Int
        var cacheCreationTokens: Int
    }

    /// The parsed final result object of a `claude -p --output-format json` run.
    struct RunResult: Equatable {
        /// What stdout used to be: the model's reply text. When the JSON could
        /// not be parsed this is the raw stdout (and `parsed` is false).
        var text: String
        var parsed: Bool
        /// `success`, `error_max_turns`, `error_during_execution`, ...
        var subtype: String?
        var isError: Bool
        var numTurns: Int?
        var usage: RunUsage?

        var hitTurnCap: Bool { subtype == "error_max_turns" }
        /// The CLI itself says the run did not complete (turn cap, error).
        var reportedFailure: Bool { parsed && (isError || (subtype.map { $0 != "success" } ?? false)) }
    }

    /// Parse the stdout of a metered run. Accepts the single result object
    /// (current CLI) or an array of events whose last `type == "result"` entry
    /// is the result. Anything else falls back to the raw text with no tokens.
    static func parseRunResult(_ data: Data) -> RunResult {
        let raw = String(data: data, encoding: .utf8) ?? ""
        let fallback = RunResult(text: raw, parsed: false, subtype: nil, isError: false, numTurns: nil, usage: nil)
        guard let json = try? JSONSerialization.jsonObject(with: data) else { return fallback }
        var obj: [String: Any]?
        if let d = json as? [String: Any] {
            obj = d
        } else if let arr = json as? [[String: Any]] {
            obj = arr.last(where: { ($0["type"] as? String) == "result" })
        }
        guard let o = obj, (o["type"] as? String).map({ $0 == "result" }) ?? (o["result"] != nil || o["usage"] != nil) else {
            return fallback
        }
        func int(_ v: Any?) -> Int? {
            if let i = v as? Int { return max(0, i) }
            if let d = v as? Double, d.isFinite { return max(0, Int(d)) }
            return nil
        }
        var usage: RunUsage?
        if let u = o["usage"] as? [String: Any] {
            usage = RunUsage(inputTokens: int(u["input_tokens"]) ?? 0,
                             outputTokens: int(u["output_tokens"]) ?? 0,
                             cacheReadTokens: int(u["cache_read_input_tokens"]) ?? 0,
                             cacheCreationTokens: int(u["cache_creation_input_tokens"]) ?? 0)
        }
        return RunResult(text: (o["result"] as? String) ?? "",
                         parsed: true,
                         subtype: o["subtype"] as? String,
                         isError: (o["is_error"] as? Bool) ?? false,
                         numTurns: int(o["num_turns"]),
                         usage: usage)
    }

    // No hardcoded Claude model list or retired-id table here. Claude's
    // models — ids, names and the default — come only from the account's live
    // list (the Agent SDK's, via the backend; see `LiveModelCache`). Before
    // the first fetch the list is empty, no model id is sent, and the SDK
    // runs the account's default.
}
