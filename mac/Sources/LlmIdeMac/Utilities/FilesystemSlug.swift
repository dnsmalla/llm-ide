import Foundation

/// Shared filename-safety rules for the two places that turn a user-facing
/// title into a filesystem-safe slug: `ProjectExporter` (KB plan/meeting
/// export) and `ProposedPlanResolver` (chat's save-plan). Kept as one
/// implementation so a future fix to the unsafe-character set or Unicode
/// handling can't apply to one and silently miss the other.
enum FilesystemSlug {

    /// Unicode-aware slug. Non-ASCII letters (CJK, Arabic, Devanagari, …) are
    /// preserved as-is rather than stripped so they remain recognisable in
    /// the filename. Unsafe filesystem characters are replaced with `-`.
    ///
    /// - Parameters:
    ///   - maxLength: cap applied BEFORE `suffix` is appended, so the final
    ///     filename length is bounded by `maxLength + suffix.count`.
    ///   - fallback: returned (verbatim, not re-slugified) when `title`
    ///     yields nothing usable — e.g. it was empty or pure punctuation.
    ///   - suffix: appended after slugifying, e.g. `-\(id.suffix(8))` for a
    ///     database id, or empty when there's no id to disambiguate with.
    static func make(from title: String, maxLength: Int, fallback: String, suffix: String = "") -> String {
        var s = title.lowercased()

        // Whitespace runs -> single hyphen.
        s = s.components(separatedBy: .whitespacesAndNewlines)
             .filter { !$0.isEmpty }
             .joined(separator: "-")

        // Keep Unicode letters/digits/hyphens; drop filesystem-unsafe chars
        // (/ \ : * ? " < > |) and control characters.
        let unsafe = CharacterSet(charactersIn: "/\\:*?\"<>|")
            .union(.controlCharacters)
            .union(.illegalCharacters)
        s = s.unicodeScalars
            .filter { !unsafe.contains($0) }
            .map { String($0) }
            .joined()

        // Collapse consecutive hyphens; trim leading/trailing.
        while s.contains("--") { s = s.replacingOccurrences(of: "--", with: "-") }
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "-"))

        if s.count > maxLength {
            s = String(s.prefix(maxLength)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        }
        if s.isEmpty { s = fallback }
        return s + suffix
    }
}
