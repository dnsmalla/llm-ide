import Foundation

/// Redaction for text that is about to leave the Mac for the phone (diffs, file contents, issue
/// bodies, error text). Wraps `IncidentRedactor`, whose regexes backtrack quadratically on one huge
/// unbroken token — a single 200 000-character line took ~7 minutes — so every entry point here
/// cuts its input into bounded lines FIRST. Callers should still run it off the main actor.
enum PhoneRedaction {
    static let maxLine = 2_000

    /// Line-by-line redaction with a per-line cap and a total cap. Returns the text and whether
    /// anything was cut.
    nonisolated static func lines(_ raw: String, maxChars: Int, maxLine: Int = PhoneRedaction.maxLine) -> (text: String, truncated: Bool) {
        var out: [String] = []
        var total = 0
        var truncated = false
        for line in raw.split(separator: "\n", omittingEmptySubsequences: false) {
            var text = String(line.prefix(maxLine))
            if line.count > maxLine { text += " …[line truncated]"; truncated = true }
            text = IncidentRedactor.redact(text, limit: maxLine + 40)
            total += text.count + 1
            if total > maxChars { truncated = true; break }
            out.append(text)
        }
        return (out.joined(separator: "\n"), truncated)
    }

    /// Short single-string form for errors and notes.
    nonisolated static func short(_ s: String, limit: Int = 300) -> String {
        IncidentRedactor.redact(String(s.prefix(2_000)), limit: limit)
    }
}
