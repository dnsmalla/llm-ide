// Walks a folder of .md / .txt / .mdx files and generates "memory chunks"
// — heading-bounded sections of text. Each chunk becomes a graph node;
// a doc node `contains` each of its chunks (parent→child, as the code
// track does file→symbol);
// chunks that whole-word mention another chunk's title are linked via
// `references`. Intended as a lightweight, dependency-free first pass at
// an InfiniteBrain-style memory layer. v1: no LLM, no embeddings.

import Foundation
import GraphCore
import CryptoKit

public enum MemoryGenerator {
    /// Sourced from `GraphCore` so the app's file routing, this generator, and
    /// any change-detection fingerprint cover exactly the same set.
    public static let supportedExtensions: Set<String> = DocExtensions.markdownAndText
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

    /// Walk several roots and union the results.
    ///
    /// Every part of the union is deduplicated, not just nodes. The first
    /// version deduped nodes only, so passing the same root twice — or two
    /// overlapping roots, a parent directory and its child — kept the node set
    /// correct while silently doubling every `.contains` edge (double spring
    /// weight, doubled degree and PageRank), every `MemoryChunk` record, and
    /// the reported `docCount`. Roots are deduped by standardised path first;
    /// edges and chunks are deduped by key as the backstop for the overlap
    /// case, where the walks genuinely revisit the same documents.
    public static func generate(roots: [URL]) -> GeneratedMemory {
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        var chunks: [MemoryChunk] = []
        var docCount = 0
        var seenNodes = Set<String>()
        var seenEdges = Set<String>()
        var seenChunks = Set<String>()
        var seenRoots = Set<String>()
        let fm = FileManager.default
        for root in roots {
            guard seenRoots.insert(root.standardizedFileURL.path).inserted else { continue }
            var isDirectory: ObjCBool = false
            guard fm.fileExists(atPath: root.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else { continue }
            let memory = generate(from: root)
            var newDocs = 0
            for node in memory.graph.nodes where seenNodes.insert(node.id).inserted {
                nodes.append(node)
                if node.kind == .memoryDoc { newDocs += 1 }
            }
            for edge in memory.graph.edges {
                let key = "\(edge.fromId)\u{1}\(edge.toId)\u{1}\(edge.kind.rawValue)"
                if seenEdges.insert(key).inserted { edges.append(edge) }
            }
            for chunk in memory.chunks where seenChunks.insert(chunk.id).inserted {
                chunks.append(chunk)
            }
            // Count only documents this root newly contributed, so overlapping
            // roots do not inflate the total.
            docCount += newDocs
        }
        return GeneratedMemory(graph: CGData(nodes: nodes, edges: edges),
                               chunks: chunks, docCount: docCount)
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
                // Containment, typed as containment and pointing parent→child —
                // matching `StructureGraphBuilder`'s file→symbol convention (and
                // the direction `FileClassifier.strippingDocNodes` assumes).
                //
                // This was `chunk → doc` with kind `.relatedTo`, which was wrong
                // three ways: it inverted the hierarchy relative to the code
                // track, and it made a document's backbone indistinguishable
                // from the noisy title-match guesses that share that kind — so
                // any consumer ranking or filtering edges by strength dropped
                // the one edge that says which document a section belongs to,
                // shattering the doc graph into isolated chunks. The header
                // comment always claimed `partOf`; nothing consumed the old
                // kind or direction.
                edges.append(CGEdge(fromId: docID, toId: chunk.id,
                                    kind: .contains, confidence: .extracted))
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
        func emit(from: String, to: String, kind: CGEdgeKind,
                  confidence: CGEdgeConfidence = .extracted) {
            let key = "\(from)→\(to):\(kind.rawValue)"
            guard !emittedEdgeKeys.contains(key), from != to else { return }
            emittedEdgeKeys.insert(key)
            edges.append(CGEdge(fromId: from, toId: to, kind: kind,
                                confidence: confidence))
        }

        // (1) Wiki-links
        for chunk in allChunks {
            for target in chunk.wikiLinks {
                let matches = chunksByLowerTitle[target.lowercased()] ?? []
                for m in matches { emit(from: chunk.id, to: m.id, kind: .references) }
            }
        }

        // (2) Tag co-occurrence (capped). Tags spread across more than
        // `genericTagThreshold` chunks are organizational noise ("#api",
        // "#docs") — a clique over an arbitrary 6 of them relates nothing,
        // so generic tags are skipped entirely rather than truncated.
        //
        // Known plateau: any tag with 6-12 occurrences always emits the
        // same C(6,2)=15 pairwise edges (head always takes exactly 6 when
        // ≥6 candidates exist) — the threshold only changes behavior ABOVE
        // 12, it does not graduate edge volume within [6, 12]. Acceptable
        // for now: bounded, cheap to reason about. Revisit if that plateau
        // itself proves noisy in practice.
        let tagCap = 6
        let genericTagThreshold = 12
        var byTag: [String: [String]] = [:]
        for chunk in allChunks {
            for t in chunk.tags { byTag[t, default: []].append(chunk.id) }
        }
        for (_, ids) in byTag where ids.count > 1 && ids.count <= genericTagThreshold {
            // Connect first `tagCap` chunks pairwise to bound edges per tag.
            let head = Array(ids.prefix(tagCap))
            for i in 0..<head.count {
                for j in (i+1)..<head.count {
                    emit(from: head[i], to: head[j], kind: .relatedTo,
                         confidence: .inferred)
                }
            }
        }

        // (3) Fallback whole-word title match for chunks lacking explicit links.
        //
        // A title can only whole-word-match a body if its *leading* word also
        // appears (as a whole word) in that body. So index titles by their first
        // word and, for each chunk, test only the titles whose first word is one
        // of the body's words — instead of every title. The final
        // `containsWholeWord` check is unchanged, so the emitted edge set is
        // identical; this only prunes which candidates we bother testing,
        // turning the old O(chunks² × body length) scan (minutes on a few
        // thousand chunks) into ~O(chunks × body words + matches).
        func wordTokens(_ s: String) -> [String] {
            s.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        }
        var titlesByFirstWord: [String: [(id: String, needle: String)]] = [:]
        for chunk in allChunks {
            let needle = chunk.title.lowercased()
            let toks = wordTokens(needle)
            // Single-word titles ("Config", "Setup", "Main") whole-word-match
            // half the corpus — the documented source of a historical
            // 702k-edge hairball in a downstream consumer. Two-plus-word
            // titles are specific enough to keep.
            guard needle.count >= 5, toks.count >= 2, let first = toks.first else { continue }
            titlesByFirstWord[first, default: []].append((chunk.id, needle))
        }
        // Each title sits in exactly one first-word bucket and each distinct body
        // word is visited once, so every candidate is tested at most once per
        // chunk — no extra de-dupe needed (and `emit` de-dupes edge keys anyway).
        for chunk in allChunks where chunk.wikiLinks.isEmpty {
            let body = Self.strippingFencedBlocks(chunk.body).lowercased()
            for word in Set(wordTokens(body)) {
                guard let candidates = titlesByFirstWord[word] else { continue }
                for cand in candidates where cand.id != chunk.id {
                    if Self.containsWholeWord(body, needle: cand.needle) {
                        emit(from: chunk.id, to: cand.id, kind: .relatedTo,
                             confidence: .ambiguous)
                    }
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
            // Don't descend into vendor/build or generated-knowledge dirs.
            if let name = url.pathComponents.last, ExcludedDirs.names.contains(name) {
                enumerator.skipDescendants(); continue
            }
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
        let fm = Self.parseFrontmatter(text)
        text = fm.text
        let frontmatterTags = fm.tags
        let defaultKind: CGNodeKind = fm.kind ?? .memoryChunk

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
            let scanText = Self.strippingFencedBlocks(bounded)
            let bodyTags = Self.extractHashtags(scanText)
            let mergedTags = Self.mergeTags(frontmatterTags, bodyTags)
            let wikiLinks = Self.extractWikiLinks(scanText)
            chunks.append(MemoryChunk(
                id: id,
                docURL: doc,
                docTitle: docTitle,
                headingPath: headingStack,
                body: bounded,
                kind: kind,
                tags: mergedTags,
                wikiLinks: wikiLinks,
                graphOnly: fm.graphOnly,
                relatedModules: fm.relatedModules
            ))
            bodyBuf.removeAll(keepingCapacity: true)
        }

        var inFence = false
        for line in lines {
            let fenceMark = line.trimmingCharacters(in: .whitespaces)
            if fenceMark.hasPrefix("```") || fenceMark.hasPrefix("~~~") {
                inFence.toggle()
                bodyBuf.append(line)
                continue
            }
            if !inFence, let (level, text) = parseHeading(line) {
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

    struct ParsedFrontmatter {
        var text: String
        var kind: CGNodeKind?
        var tags: [String]
        var graphOnly: Bool
        var relatedModules: [String]
    }

    /// Strip a leading YAML frontmatter block and pull out `type`/`kind`,
    /// `tags`, `graph-only` (or `graphOnly`), and `related-modules` (or
    /// `relatedModules`). Tolerant — bad YAML is silently dropped.
    ///
    /// Uses a small line parser instead of `Yams.load` for the frontmatter
    /// block: agent skill/tool files often carry long single-line
    /// `description:` values with unquoted colons, and nested `schema:`
    /// mappings — `Yams.load` can trap on some of those inputs even inside
    /// `try?`, taking down the host process during background graph builds.
    static func parseFrontmatter(_ text: String) -> ParsedFrontmatter {
        guard text.hasPrefix("---\n") else {
            return ParsedFrontmatter(text: text, kind: nil, tags: [], graphOnly: false, relatedModules: [])
        }
        let afterFirst = text.index(text.startIndex, offsetBy: 4)
        guard let endRange = text.range(of: "\n---\n", range: afterFirst..<text.endIndex) else {
            return ParsedFrontmatter(text: text, kind: nil, tags: [], graphOnly: false, relatedModules: [])
        }
        let yamlBlock = String(text[afterFirst..<endRange.lowerBound])
        // The closing fence's trailing newline belongs to the fence, not the
        // body: trim it so the body always starts at its first content
        // character (the frontmatter tests pin this contract).
        let remaining = String(text[endRange.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let yaml = parseSimpleFrontmatterMapping(yamlBlock)
        let rawType = unquote(yaml["type"] ?? yaml["kind"] ?? "")
        let tags = parseFrontmatterTags(normalizeFrontmatterList(yaml["tags"]))
        let graphOnly = parseBool(yaml["graph-only"] ?? yaml["graphOnly"]) ?? false
        let relatedModules = parseModuleList(
            normalizeFrontmatterList(yaml["related-modules"] ?? yaml["relatedModules"]))
        return ParsedFrontmatter(text: remaining, kind: kindFromTypeString(rawType),
                                 tags: tags, graphOnly: graphOnly, relatedModules: relatedModules)
    }

    /// Minimal YAML-ish frontmatter parser for the few keys MemoryGenerator
    /// cares about. Only reads top-level `key: value` lines; everything after
    /// the first colon on a line is kept verbatim (so descriptions may contain
    /// colons). Indented continuation lines are appended to the current value.
    static func parseSimpleFrontmatterMapping(_ block: String) -> [String: String] {
        var out: [String: String] = [:]
        var currentKey: String?
        var currentValue = ""
        func flush() {
            if let key = currentKey {
                out[key] = currentValue.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            currentKey = nil
            currentValue = ""
        }
        for lineSub in block.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(lineSub)
            if line.hasPrefix(" ") || line.hasPrefix("\t") {
                if currentKey != nil {
                    if !currentValue.isEmpty { currentValue.append("\n") }
                    currentValue.append(line.trimmingCharacters(in: .whitespaces))
                }
                continue
            }
            flush()
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            let value = String(line[line.index(after: colon)...])
            currentKey = key
            currentValue = value
        }
        flush()
        return out
    }

    static func parseBool(_ raw: String?) -> Bool? {
        guard let raw else { return nil }
        switch unquote(raw).lowercased() {
        case "true", "yes", "1": return true
        case "false", "no", "0": return false
        default: return nil
        }
    }

    /// Strip surrounding single/double quotes from a scalar.
    static func unquote(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count >= 2 else { return s }
        for q in ["\"", "'"] where s.hasPrefix(q) && s.hasSuffix(q) {
            return String(s.dropFirst().dropLast())
        }
        return s
    }

    /// Bridge the line parser's raw string values back to the shapes
    /// `parseFrontmatterTags`/`parseModuleList` expect. Yams used to hand those
    /// a real `[Any]` for `tags: [a, b]` and block lists; the line parser only
    /// produces strings, so tokenize sequences here and pass plain scalars
    /// through unchanged (their comma/space splitting still applies).
    /// Returns `nil` for an absent key so the callers' "no value" path stands.
    static func normalizeFrontmatterList(_ raw: String?) -> Any? {
        guard let raw else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        // Block sequence: the line parser joined `- item` lines with newlines.
        if s.hasPrefix("- ") || s.hasPrefix("-\n") || s.contains("\n- ") {
            return s.split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { $0.hasPrefix("-") }
                .map { unquote(String($0.dropFirst())) }
                .filter { !$0.isEmpty }
        }
        // Flow sequence: [a, b] / ["a", "b"].
        if s.hasPrefix("[") && s.hasSuffix("]") {
            let inner = String(s.dropFirst().dropLast())
            return inner.split(separator: ",")
                .map { unquote(String($0)) }
                .filter { !$0.isEmpty }
        }
        return unquote(s)
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

    /// Module paths: accept YAML array or comma/space string. Trimmed,
    /// deduped, case PRESERVED (unlike tags — these are file paths).
    static func parseModuleList(_ raw: Any?) -> [String] {
        let parts: [String]
        switch raw {
        case let array as [Any]:
            parts = array.compactMap { ($0 as? String) ?? ($0 as? CustomStringConvertible).map { "\($0)" } }
        case let s as String:
            parts = s.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map(String.init)
        default:
            return []
        }
        var seen = Set<String>()
        var out: [String] = []
        for p in parts {
            let cleaned = p.trimmingCharacters(in: .whitespaces)
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

    /// Returns (level, text) for ATX headings like `## Foo`. Fence awareness
    /// is handled by the caller's `inFence` state in `chunk()`.
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

    /// Remove fenced code blocks (``` / ~~~ delimited) so tag / wikilink /
    /// title scanning never reads code as prose. Chunk bodies keep their
    /// fences — this is applied only to the text handed to the extractors.
    /// An unclosed fence swallows to end-of-text (same as markdown renderers).
    ///
    /// Known limitations (acceptable — this is a heuristic scanner, not a
    /// full CommonMark parser): fence toggling matches by PRESENCE of a
    /// marker only, not by matching character/length, so a mismatched
    /// marker inside a real fence (e.g. a stray `~~~` line inside a ```
    /// fence) can desync the toggle for the rest of the document. Also,
    /// indentation is not considered — a fence marker indented 4+ spaces
    /// (which in strict CommonMark is literal text inside an already-
    /// indented code block, not a real fence) is still treated as a toggle.
    static func strippingFencedBlocks(_ body: String) -> String {
        var out: [String] = []
        var inFence = false
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") || t.hasPrefix("~~~") { inFence.toggle(); continue }
            if !inFence { out.append(String(line)) }
        }
        return out.joined(separator: "\n")
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
