// Asks the sub-model for a single shell command that fails when a fault
// is present and passes when it's fixed. Called once when a fault is
// marked `fixed`. A reply of NONE (or empty) means no runnable check —
// the fault then rides the answer-compare fallback.

import Foundation

enum VerifyCommandAuthor {
    static func buildPrompt(fault: FaultReport, repoRoot: URL) -> String {
        """
        You just confirmed this fault is fixed in the repo at \(repoRoot.path).

        Fault: \(String(fault.prompt.prefix(1_000)))
        Fix summary: \(String(fault.response.prefix(2_000)))

        Give the SINGLE shell command, runnable from the repo root, that
        exits non-zero if this fault is present and exits zero if it is
        fixed (prefer an existing test). Reply with ONLY the command on
        one line, or exactly NONE if no such command exists.
        """
    }

    /// nil ⇔ no runnable command. Strips code fences and whitespace.
    static func parseReply(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("```") {
            s = s.replacingOccurrences(of: "```", with: "")
                 .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if s.isEmpty || s.uppercased() == "NONE" { return nil }
        return s.split(separator: "\n").first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Production call — uses the sub-model tier.
    static func author(fault: FaultReport, repoRoot: URL, api: LlmIdeAPIClient) async -> String? {
        let prompt = buildPrompt(fault: fault, repoRoot: repoRoot)
        guard let resp = try? await api.codeAssist(
            message: prompt, language: "en", model: nil, tier: "subagent",
            history: [], attachments: [], agentContext: nil
        ) else { return nil }
        return parseReply(resp.reply)
    }
}
