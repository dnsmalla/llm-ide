// Walks a folder of .md / .txt / .mdx files and generates "memory chunks"
// — heading-bounded sections of text. Each chunk becomes a graph node;
// chunks within the same doc are linked via `partOf` to a doc node;
// chunks that whole-word mention another chunk's title are linked via
// `references`. Intended as a lightweight, dependency-free first pass at
// an InfiniteBrain-style memory layer. v1: no LLM, no embeddings.

import Foundation
import CryptoKit
import Yams

public struct GeneratedMemory: Sendable {
    public let graph: CGData
    public let chunks: [MemoryChunk]   // flat, ordered (doc → its chunks)
    public let docCount: Int
}

public struct MemoryChunk: Identifiable, Sendable, Hashable {
    public let id: String              // stable: <sha256 short of path + heading-path>
    public let docURL: URL
    public let docTitle: String        // file name minus extension
    public let headingPath: [String]   // ["Section", "Subsection"]
    public let body: String            // accumulated lines until next heading at <= level
    public let kind: CGNodeKind        // typed via frontmatter or heading heuristics
    public let tags: [String]          // lowercased, from #hashtags + frontmatter `tags:`
    public let wikiLinks: [String]     // raw target titles from [[Title]] (case as-written)
    public var title: String {
        headingPath.last ?? docTitle
    }
    public var displayHeading: String {
        headingPath.isEmpty ? "(preamble)" : headingPath.joined(separator: " › ")
    }
}

public enum MemoryGenerator {
    public static let supportedExtensions: Set<String> = ["md", "mdx", "markdown", "txt"]
    public static let maxChunkBodyChars = 4000

    /// Generate from an explicit list of files. The caller (usually backed
    /// by LibraryItemStore) already knows exactly which docs to chunk;
    /// no folder walk needed.
    public static func generate(files: [URL]) -> GeneratedMemory {
        let docs = files.filter { url in
            supportedExtensions.contains(url.pathExtension.lowercased())
                && (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }
        .sorted { $0.path < $1.path }
        return generate(docs: docs)
    }

    /// Convenience: walk a folder and build a memory graph.
    /// File-system traversal is bounded; binary/large files are skipped.
    public static func generate(from root: URL,
                                maxFiles: Int = 500,
                                maxFileBytes: Int = 2_000_000) -> GeneratedMemory {
        let docs = collectDocs(root: root, maxFiles: maxFiles, maxFileBytes: maxFileBytes)
        return generate(docs: docs)
    }

    private static func generate(docs: [URL]) -> GeneratedMemory {
        var allChunks: [MemoryChunk] = []
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []

        for doc in docs {
            let docID = "doc:" + Self.shortHash(doc.path)
            let docTitle = doc.deletingPathExtension().lastPathComponent
            nodes.append(CGNode(
                id: docID,
                title: docTitle,
                kind: .memoryDoc,
                metadata: ["fileURL": doc.absoluteString]
            ))
            let chunks = Self.chunk(doc: doc, docID: docID, docTitle: docTitle)
            for chunk in chunks {
                allChunks.append(chunk)
                nodes.append(CGNode(
                    id: chunk.id,
                    title: chunk.title,
                    kind: chunk.kind,
                    metadata: [
                        "fileURL": chunk.docURL.absoluteString,
                        "doc": chunk.docTitle,
                        "heading": chunk.displayHeading,
                        "type": chunk.kind.displayName
                    ]
                ))
                edges.append(CGEdge(fromId: chunk.id, toId: docID, kind: .relatedTo))
            }
        }

        // Cross-chunk edges in priority order:
        //   1. [[Wiki-links]] — explicit user intent, kind: .references.
        //   2. Frontmatter / #hashtag co-occurrence — kind: .relatedTo,
        //      capped per-tag to avoid edge explosion on popular tags.
        //   3. Whole-word title fallback ONLY when the source chunk has
        //      no explicit wiki-links — kind: .relatedTo. Catches notes
        //      that aren't yet wiki-linked but still co-reference.
        let chunksByLowerTitle = Dictionary(grouping: allChunks) { $0.title.lowercased() }
        var emittedEdgeKeys = Set<String>()   // "from→to:kind", de-dupes
        func emit(from: String, to: String, kind: CGEdgeKind) {
            let key = "\(from)→\(to):\(kind.rawValue)"
            guard !emittedEdgeKeys.contains(key), from != to else { return }
            emittedEdgeKeys.insert(key)
            edges.append(CGEdge(fromId: from, toId: to, kind: kind))
        }

        // (1) Wiki-links
        for chunk in allChunks {
            for target in chunk.wikiLinks {
                let matches = chunksByLowerTitle[target.lowercased()] ?? []
                for m in matches { emit(from: chunk.id, to: m.id, kind: .references) }
            }
        }

        // (2) Tag co-occurrence (capped)
        let tagCap = 6
        var byTag: [String: [String]] = [:]
        for chunk in allChunks {
            for t in chunk.tags { byTag[t, default: []].append(chunk.id) }
        }
        for (_, ids) in byTag where ids.count > 1 {
            // Connect first `tagCap` chunks pairwise to bound edges per tag.
            let head = Array(ids.prefix(tagCap))
            for i in 0..<head.count {
                for j in (i+1)..<head.count {
                    emit(from: head[i], to: head[j], kind: .relatedTo)
                }
            }
        }

        // (3) Fallback whole-word title match for chunks lacking explicit links
        let titleByID = Dictionary(uniqueKeysWithValues: allChunks.map { ($0.id, $0.title) })
        for chunk in allChunks where chunk.wikiLinks.isEmpty {
            let body = chunk.body.lowercased()
            for (otherID, otherTitle) in titleByID where otherID != chunk.id {
                let needle = otherTitle.lowercased()
                guard needle.count >= 5 else { continue }   // tighter than v1 to cut noise
                if Self.containsWholeWord(body, needle: needle) {
                    emit(from: chunk.id, to: otherID, kind: .relatedTo)
                }
            }
        }

        return GeneratedMemory(
            graph: CGData(nodes: nodes, edges: edges),
            chunks: allChunks,
            docCount: docs.count
        )
    }

    // MARK: - Internals

    private static func collectDocs(root: URL, maxFiles: Int, maxFileBytes: Int) -> [URL] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }
        var result: [URL] = []
        for case let url as URL in enumerator {
            if result.count >= maxFiles { break }
            let ext = url.pathExtension.lowercased()
            guard supportedExtensions.contains(ext) else { continue }
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true else { continue }
            if let size = values?.fileSize, size > maxFileBytes { continue }
            result.append(url)
        }
        result.sort { $0.path < $1.path }
        return result
    }

    private static func chunk(doc: URL, docID: String, docTitle: String) -> [MemoryChunk] {
        guard var text = try? String(contentsOf: doc, encoding: .utf8) else { return [] }

        // 1. Strip + parse YAML frontmatter (`---\n…\n---`). Sets a default
        //    type for every chunk in this doc unless a heading overrides.
        //    Frontmatter `tags:` applies to every chunk in the doc.
        let frontmatterType: CGNodeKind?
        let frontmatterTags: [String]
        (text, frontmatterType, frontmatterTags) = Self.stripFrontmatterType(text)
        let defaultKind: CGNodeKind = frontmatterType ?? .memoryChunk

        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        var chunks: [MemoryChunk] = []
        var headingStack: [String] = []
        var headingLevels: [Int] = []
        var bodyBuf: [String] = []

        func flush() {
            let body = bodyBuf.joined(separator: "\n")
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  || !headingStack.isEmpty else {
                bodyBuf.removeAll(keepingCapacity: true)
                return
            }
            let bounded = String(body.prefix(maxChunkBodyChars))
            let id = "\(docID)::" + Self.shortHash(headingStack.joined(separator: "/"))
                                       + ":\(chunks.count)"
            // Heading heuristic wins over frontmatter default.
            let kind = Self.classify(heading: headingStack.last, body: bounded)
                       ?? defaultKind
            let bodyTags = Self.extractHashtags(bounded)
            let mergedTags = Self.mergeTags(frontmatterTags, bodyTags)
            let wikiLinks = Self.extractWikiLinks(bounded)
            chunks.append(MemoryChunk(
                id: id,
                docURL: doc,
                docTitle: docTitle,
                headingPath: headingStack,
                body: bounded,
                kind: kind,
                tags: mergedTags,
                wikiLinks: wikiLinks
            ))
            bodyBuf.removeAll(keepingCapacity: true)
        }

        for line in lines {
            if let (level, text) = parseHeading(line) {
                flush()
                while let lastLevel = headingLevels.last, lastLevel >= level {
                    headingStack.removeLast()
                    headingLevels.removeLast()
                }
                headingStack.append(text)
                headingLevels.append(level)
            } else {
                bodyBuf.append(line)
            }
        }
        flush()
        return chunks
    }

    /// Strip a leading YAML frontmatter block (`---\n…\n---\n`) and pull
    /// out a recognized `type` and a `tags` list. Returns the remaining
    /// text plus the type kind (nil if no frontmatter or unmapped) and
    /// the tag array (lowercased, deduped, empty when absent). Tolerant
    /// — bad YAML is silently dropped rather than failing the whole doc.
    static func stripFrontmatterType(_ text: String) -> (String, CGNodeKind?, [String]) {
        guard text.hasPrefix("---\n") else { return (text, nil, []) }
        let afterFirst = text.index(text.startIndex, offsetBy: 4)
        guard let endRange = text.range(of: "\n---\n", range: afterFirst..<text.endIndex)
        else { return (text, nil, []) }
        let yamlBlock = String(text[afterFirst..<endRange.lowerBound])
        let remaining = String(text[endRange.upperBound...])
        guard let yaml = try? Yams.load(yaml: yamlBlock) as? [String: Any] else {
            return (remaining, nil, [])
        }
        let rawType = (yaml["type"] as? String) ?? (yaml["kind"] as? String) ?? ""
        let tags = parseFrontmatterTags(yaml["tags"])
        return (remaining, kindFromTypeString(rawType), tags)
    }

    /// Accept either YAML array (`tags: [foo, bar]`) or comma/space string
    /// (`tags: foo, bar baz`). Lowercased, trimmed, deduped, leading "#" stripped.
    static func parseFrontmatterTags(_ raw: Any?) -> [String] {
        let parts: [String]
        switch raw {
        case let array as [Any]:
            parts = array.compactMap { ($0 as? String) ?? ($0 as? CustomStringConvertible).map { "\($0)" } }
        case let s as String:
            // Split on whitespace or comma.
            parts = s.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
        default:
            return []
        }
        var seen = Set<String>()
        var out: [String] = []
        for p in parts {
            let cleaned = p.trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
                .lowercased()
            guard !cleaned.isEmpty, !seen.contains(cleaned) else { continue }
            seen.insert(cleaned); out.append(cleaned)
        }
        return out
    }

    // MARK: - Body extractors

    /// `[[Target]]` and `[[Target|alias]]` — captures the target only.
    static func extractWikiLinks(_ body: String) -> [String] {
        let pattern = #"\[\[([^\[\]\|\n]+)(?:\|[^\[\]\n]*)?\]\]"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = body as NSString
        var out: [String] = []
        var seen = Set<String>()
        for m in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            guard m.numberOfRanges >= 2 else { continue }
            let target = ns.substring(with: m.range(at: 1))
                .trimmingCharacters(in: .whitespaces)
            guard !target.isEmpty, !seen.contains(target) else { continue }
            seen.insert(target); out.append(target)
        }
        return out
    }

    /// `#tag` outside of fenced code (best-effort — we ignore the corner
    /// cases of `#` inside inline code, since that's rare). Lowercased,
    /// deduped, must start with a letter so we don't pick up `#1` or `#42`.
    static func extractHashtags(_ body: String) -> [String] {
        let pattern = #"(?:^|[\s\(\[])#([A-Za-z][A-Za-z0-9_/\-]*)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = body as NSString
        var out: [String] = []
        var seen = Set<String>()
        for m in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            guard m.numberOfRanges >= 2 else { continue }
            let tag = ns.substring(with: m.range(at: 1)).lowercased()
            guard !seen.contains(tag) else { continue }
            seen.insert(tag); out.append(tag)
        }
        return out
    }

    private static func kindFromTypeString(_ s: String) -> CGNodeKind? {
        let key = s.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        switch key {
        case "decision":           return .noteDecision
        case "task", "todo":       return .noteTask
        case "question", "open":   return .noteQuestion
        case "fact":               return .noteFact
        case "concept":            return .noteConcept
        case "playbook", "sop",
             "process":            return .notePlaybook
        case "hypothesis":         return .noteHypothesis
        case "event", "meeting":   return .noteEvent
        case "source",
             "reference":          return .noteSource
        default:                   return nil
        }
    }

    /// Heading-keyword + body-pattern heuristic. Cheap, no LLM. Returns nil
    /// when nothing matches so the caller falls back to the doc default.
    static func classify(heading: String?, body: String) -> CGNodeKind? {
        let h = (heading ?? "").lowercased()
        // Direct heading-keyword match — strongest signal.
        if h.contains("decision")       { return .noteDecision }
        if h.contains("question")
           || h.hasSuffix("?")          { return .noteQuestion }
        if h.contains("hypothesis")     { return .noteHypothesis }
        if h.contains("playbook")
           || h.contains("how to")
           || h.contains("how-to")
           || h.contains("runbook")
           || h.contains("sop")         { return .notePlaybook }
        if h.contains("task")
           || h.contains("todo")
           || h.contains("action item") { return .noteTask }
        if h.contains("fact")
           || h.contains("metric")
           || h.contains("number")      { return .noteFact }
        if h.contains("concept")
           || h.contains("definition")
           || h.contains("glossary")    { return .noteConcept }
        if h.contains("meeting")
           || h.contains("standup")
           || h.contains("retro")       { return .noteEvent }
        if h.contains("source")
           || h.contains("reference")
           || h.contains("citation")    { return .noteSource }

        // Body shape — `- [ ]` checkboxes ⇒ task cluster.
        if body.range(of: #"(?m)^\s*-\s*\[[ x]\]\s"#, options: .regularExpression) != nil {
            return .noteTask
        }
        return nil
    }

    /// Returns (level, text) for ATX headings like `## Foo`. Skips fenced
    /// code blocks would be nice but markdown awareness is out of scope.
    private static func parseHeading(_ line: String) -> (Int, String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("#") else { return nil }
        var level = 0
        var idx = trimmed.startIndex
        while idx < trimmed.endIndex, trimmed[idx] == "#" {
            level += 1
            idx = trimmed.index(after: idx)
        }
        guard (1...6).contains(level),
              idx < trimmed.endIndex,
              trimmed[idx] == " " else { return nil }
        let text = String(trimmed[idx...]).trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (level, text)
    }

    /// Whole-word substring check. Uses word boundaries (non-alphanumeric
    /// or string edge). Case-insensitive — caller passes already-lowercased.
    static func containsWholeWord(_ haystack: String, needle: String) -> Bool {
        guard !needle.isEmpty, var range = haystack.range(of: needle) else { return false }
        while true {
            let leftOK: Bool = {
                if range.lowerBound == haystack.startIndex { return true }
                let prev = haystack.index(before: range.lowerBound)
                return !haystack[prev].isLetter && !haystack[prev].isNumber
            }()
            let rightOK: Bool = {
                if range.upperBound == haystack.endIndex { return true }
                return !haystack[range.upperBound].isLetter && !haystack[range.upperBound].isNumber
            }()
            if leftOK && rightOK { return true }
            guard let next = haystack.range(of: needle, range: range.upperBound..<haystack.endIndex)
            else { return false }
            range = next
        }
    }

    static func mergeTags(_ a: [String], _ b: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for t in a + b where !t.isEmpty && !seen.contains(t) {
            seen.insert(t); out.append(t)
        }
        return out
    }

    /// SHA-256 prefix. Chunk IDs are used as graph node IDs and as keys
    /// in lookup tables — collisions would silently merge unrelated
    /// chunks, so we pay the (tiny) cost of a real hash here.
    private static func shortHash(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        // 16 hex chars = 64 bits, ample for in-memory identity within
        // a single doc set (typical: <10k chunks).
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}
