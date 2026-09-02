import Foundation
import GraphCore

/// Resolves shape-qualified code mentions in doc chunks against a code
/// symbol inventory, producing doc→code link candidates. This is the
/// deterministic replacement for wikilink-only doc→code linking (which
/// requires authors to write `[[Target]]` — something real docs never do).
///
/// A "mention" is an inline backtick span (`` `like/this.mjs` `` or
/// `` `backupTo` ``): backticks are the author explicitly marking a code
/// entity, which is what keeps precision high — plain prose words never
/// match (see the API-mention ambiguity literature). Fenced blocks are
/// stripped first: code samples quote many identifiers incidentally.
///
/// Pure + Sendable: the caller (llm-ide's KnowledgeGraphService) builds
/// the inventory from its code graph and merges the returned links.
public enum DocCodeLinker {
    public struct Link: Sendable, Hashable, Codable {
        public let chunkID: String
        public let codeNodeID: String
        public let mention: String     // as written in the doc
        public let confidence: Double  // 0.9 path-shaped, 0.7 symbol-shaped
        // Note: "." is a cheap proxy for path/file-extension shape, not a
        // true path check — a dotted symbol reference (`self.foo`) or a
        // version string would also score 0.9. This only affects RANKING
        // (which confidence tier a link gets), never WHETHER a link is
        // emitted — the inventory lookup is the sole gate on that.

        public init(chunkID: String, codeNodeID: String, mention: String, confidence: Double) {
            self.chunkID = chunkID
            self.codeNodeID = codeNodeID
            self.mention = mention
            self.confidence = confidence
        }
    }

    /// `inventory`: lowercased code-entity name → code node IDs. Callers
    /// should key by relative file path ("kb/db.mjs"), file basename
    /// ("db.mjs"), and symbol name ("backupto") as they see fit — the
    /// linker just matches lowercased mention text against the keys.
    public static func links(chunks: [MemoryChunk],
                             inventory: [String: [String]]) -> [Link] {
        guard !inventory.isEmpty else { return [] }
        var out: [Link] = []
        var seen = Set<String>()
        for chunk in chunks {
            let scanText = MemoryGenerator.strippingFencedBlocks(chunk.body)
            for mention in inlineCodeSpans(scanText) {
                guard let ids = inventory[mention.lowercased()] else { continue }
                let confidence = mention.contains("/") || mention.contains(".") ? 0.9 : 0.7
                for id in ids {
                    let key = "\(chunk.id)->\(id)"
                    guard seen.insert(key).inserted else { continue }
                    out.append(Link(chunkID: chunk.id, codeNodeID: id,
                                    mention: mention, confidence: confidence))
                }
            }
        }
        return out
    }

    /// Inline `` `span` `` contents that look like code entities: 2–120
    /// chars, no whitespace (prose in backticks is not an identifier).
    static func inlineCodeSpans(_ text: String) -> [String] {
        let pattern = #"`([^`\n]{2,120})`"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        var out: [String] = []
        var seen = Set<String>()
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard m.numberOfRanges >= 2 else { continue }
            let span = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            guard !span.isEmpty,
                  !span.contains(" "), !span.contains("\t"),
                  !seen.contains(span) else { continue }
            seen.insert(span); out.append(span)
        }
        return out
    }
}
