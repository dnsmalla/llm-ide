import Foundation

/// Minimal reader for the `---` fenced header at the top of a markdown file.
///
/// Deliberately not a YAML parser: the files this reads (Auto Task templates,
/// `SKILL.md` manifests) carry a handful of flat `key: value` lines, and
/// pulling those out is all any caller needs. Anything structured belongs in
/// its own typed model with Yams behind it.
///
/// Pure — no I/O — so callers stay testable without files on disk.
enum MarkdownFrontmatter {

    /// Split `---\n…\n---\n<body>` into its header and body.
    ///
    /// Returns nil when the text does not open with a fence or the fence is
    /// never closed; the caller then treats the whole file as body, which is
    /// what makes a plain markdown file with no header still readable.
    static func split(_ text: String) -> (header: String, body: String)? {
        // Normalize CRLF so a file written on Windows still parses.
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        guard normalized.hasPrefix("---\n") else { return nil }
        let afterOpen = normalized.dropFirst(4)
        guard let closeRange = afterOpen.range(of: "\n---") else { return nil }
        let header = String(afterOpen[afterOpen.startIndex..<closeRange.lowerBound])
        var body = String(afterOpen[closeRange.upperBound...])
        // Drop the rest of the closing fence line, then the blank lines the
        // writer left between it and the content.
        if let newline = body.firstIndex(of: "\n") {
            body = String(body[body.index(after: newline)...])
        } else {
            body = ""
        }
        while body.hasPrefix("\n") { body.removeFirst() }
        return (header, body)
    }

    /// First `key: value` line in a header, with surrounding double quotes
    /// removed and `\"` / `\\` unescaped. nil when the key is absent or its
    /// value is blank.
    static func value(forKey key: String, in header: String) -> String? {
        for line in header.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("\(key):") else { continue }
            let raw = String(trimmed.dropFirst(key.count + 1))
                .trimmingCharacters(in: .whitespaces)
            guard !raw.isEmpty else { return nil }
            guard raw.hasPrefix("\""), raw.hasSuffix("\""), raw.count >= 2 else { return raw }
            return String(raw.dropFirst().dropLast())
                .replacingOccurrences(of: "\\\"", with: "\"")
                .replacingOccurrences(of: "\\\\", with: "\\")
        }
        return nil
    }

    /// A value quoted for writing back into a header, so a string containing
    /// `:` or `#` round-trips through `value(forKey:in:)` unchanged.
    static func quoted(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
