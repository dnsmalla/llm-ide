import Foundation

/// Minimal markdown handling for chat transcripts.
///
/// `Text(someString)` does NOT parse markdown — SwiftUI only does that for
/// string *literals* — so agent replies rendered as raw `**bold**`, backticks
/// and ``` fences on the phone while the Mac showed them formatted. Rather than
/// pull in a renderer, this splits a reply into prose and fenced-code segments;
/// prose then goes through `AttributedString(markdown:)` (inline syntax only),
/// and code keeps its whitespace in a monospaced block.
///
/// Pure and separately testable: the parser is the part that can silently eat
/// content, and it must never do that (an unterminated fence in a truncated
/// reply still has to render everything it received).
enum ChatMarkdown {

    /// Deliberately NOT `Identifiable`: a reply can legitimately repeat a block
    /// verbatim (before/after snippets, the same command in two steps), so any
    /// content-derived id collides — and `ForEach` over duplicate ids renders
    /// one and silently drops the rest. Callers key on POSITION instead.
    enum Segment: Equatable {
        /// Text to render with inline markdown applied.
        case prose(String)
        /// A fenced block: verbatim body plus the fence's language, if any.
        case code(language: String?, body: String)
    }

    /// Split on ``` fences. An unterminated fence yields its accumulated body
    /// as a code segment rather than dropping it.
    static func segments(from text: String) -> [Segment] {
        guard text.contains("```") else {
            let prepared = prepareProse(text)
            return prepared.isEmpty ? [] : [.prose(prepared)]
        }
        var segments: [Segment] = []
        var prose: [String] = []
        var code: [String] = []
        var language: String?
        var inCode = false

        func flushProse() {
            let joined = prepareProse(prose.joined(separator: "\n"))
            if !joined.isEmpty { segments.append(.prose(joined)) }
            prose.removeAll()
        }
        func flushCode() {
            // Keep an all-whitespace body: it is still part of the reply.
            if !code.isEmpty {
                segments.append(.code(language: language, body: code.joined(separator: "\n")))
            }
            code.removeAll()
            language = nil
        }

        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    flushCode()
                    inCode = false
                    // A malformed closing fence can carry trailing text
                    // ("```extra"); keep it rather than dropping it.
                    let trailing = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    if !trailing.isEmpty { prose.append(String(trailing)) }
                } else {
                    flushProse()
                    let tag = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    language = tag.isEmpty ? nil : tag
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line) } else { prose.append(line) }
        }
        // Unterminated fence — emit what we have instead of losing it.
        if inCode { flushCode() } else { flushProse() }
        // Last-resort guarantee: non-empty input never renders as nothing
        // (e.g. a message consisting only of fence markers).
        if segments.isEmpty, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return [.prose(text)]
        }
        return segments
    }

    /// Fold the block-level syntax `AttributedString`'s inline parsing ignores
    /// into inline equivalents, so a heading doesn't render as a literal "## ".
    static func prepareProse(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n").map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // ATX heading → bold. Empty headings ("###") are left alone.
            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix(while: { $0 == "#" })
                let after = trimmed.dropFirst(hashes.count)
                // A space after the hash run is REQUIRED by CommonMark —
                // without this check `#include <stdio.h>` and `#hashtag`
                // render as bogus headings.
                let rest = after.trimmingCharacters(in: .whitespaces)
                if hashes.count <= 6, after.first == " ", !rest.isEmpty { return "**\(rest)**" }
            }
            // Unordered list marker → bullet, preserving the original indent.
            for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
                let indent = line.prefix(while: { $0 == " " || $0 == "\t" })
                return "\(indent)•  \(trimmed.dropFirst(marker.count))"
            }
            return line
        }
        return lines.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
