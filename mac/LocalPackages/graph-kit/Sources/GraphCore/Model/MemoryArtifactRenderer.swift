import Foundation

/// Renders the agent-facing memory artifacts — `graph-notes.md` and
/// `doc-notes.md` — from a graph and its chunks.
///
/// Pure functions: graph in, markdown out. The artifact FORMAT is a
/// cross-component contract (the Node extension's `graphkit/memory.mjs` reads
/// these files into the agent's prompt), which is why rendering lives in
/// GraphCore beside the model rather than in the app or in the pluggable
/// engine: every implementation that writes these files must agree on the
/// shape, and the app must still be able to explain an existing artifact with
/// no engine installed. File I/O stays with the caller — the app decides where
/// and when to write.
///
/// Replaces `MemoryNotesWriter`, which claimed this role and delivered none of
/// it: zero callers, an output path retired a year ago
/// (`.understand-anything/memory/`), sections keyed to a node kind (`.symbol`)
/// no producer emits and metadata keys (`path`, `file`) no producer sets —
/// every section it rendered came out empty.
public enum MemoryArtifactRenderer {

    /// Render `graph-notes.md`: counts plus the doc→code cross-links (the
    /// cross-domain edges Stage 2 adds), which are the most useful thing the
    /// agent can't get from the code or docs alone. Routing: like
    /// `renderDocNotes`, chunks marked `graph-only: true` or classified
    /// `.noteEvent` are excluded here too — `graph-notes.md` lives in the
    /// same agent-facing memory artifact directory as `doc-notes.md`, so the
    /// same exclusion contract must hold for both files, not just one of
    /// them. (The interactive GRAPH itself, via `merge()`, still contains
    /// these edges — only the memory-artifact rendering excludes them.)
    public static func renderGraphNotes(code: CGData, doc: CGData, merged: CGData,
                                             chunks: [MemoryChunk]) -> String {
        // Chunk graph-node ids equal MemoryChunk.id (see merge()'s doc
        // comment) — exclude graph-only/meeting chunk ids from both the doc
        // title lookup and the cross-link rendering below.
        let excludedIds = Set(chunks.filter { $0.graphOnly || $0.kind == .noteEvent }.map(\.id))
        var out = "# Graph notes\n\n"
        out += "- Code nodes: \(code.nodes.count)\n- Doc nodes: \(doc.nodes.count)\n- Edges: \(merged.edges.count)\n\n"
        let codeIds = Set(code.nodes.map(\.id))
        let docTitle = Dictionary(doc.nodes.filter { !excludedIds.contains($0.id) }.map { ($0.id, $0.title) },
                                  uniquingKeysWith: { a, _ in a })
        let codeTitle = Dictionary(code.nodes.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
        let crossLinks = merged.edges.filter {
            $0.kind == .references && docTitle[$0.fromId] != nil && codeIds.contains($0.toId)
        }
        if !crossLinks.isEmpty {
            let shown = 50
            out += "## Doc → code references\n"
            for e in crossLinks.prefix(shown) {
                out += "- \(docTitle[e.fromId] ?? e.fromId) → \(codeTitle[e.toId] ?? e.toId)\n"
            }
            // Say so when the list is cut off. Without this the agent reads a
            // truncated list as the complete set of doc→code links and can
            // conclude a real reference doesn't exist.
            if crossLinks.count > shown {
                out += "- …and \(crossLinks.count - shown) more (list truncated)\n"
            }
            out += "\n"
        }

        // Dependency hubs: the most-imported code nodes. The import graph is
        // the one thing the graph knows that neither repo.md prose nor doc
        // notes carry — surfacing the top of it lets the agent see cross-module
        // structure without a graph query.
        var inDegree: [String: Int] = [:]
        for e in code.edges where e.kind == .imports {
            inDegree[e.toId, default: 0] += 1
        }
        // Count descending, then key ascending for a stable tie-break. The
        // previous comparator mixed `$0`/`$1` across tuple positions —
        // `($0.value, $1.key) > ($1.value, $0.key)` — which happened to order
        // correctly but is not a valid strict weak ordering.
        let ranked = inDegree.sorted {
            $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key
        }
        let hubs = ranked.prefix(10)
        if !hubs.isEmpty {
            out += "## Dependency hubs\n"
            for (id, count) in hubs {
                out += "- \(codeTitle[id] ?? id) — imported by \(count)\n"
            }
            // Ranked list — mark it as a top-N so the agent doesn't read the
            // absence of a module here as "nothing imports it".
            if ranked.count > hubs.count {
                out += "- …top \(hubs.count) of \(ranked.count) imported modules\n"
            }
            out += "\n"
        }
        return out
    }

    /// Render `doc-notes.md`: the doc/InfiniteBrain content for the combined
    /// memory the agent reads — docs grouped by title, each listing its chunk
    /// headings. Routing: chunks marked `graph-only: true` (frontmatter — an
    /// explicit, author-controlled opt-out) and meeting-style chunks
    /// (`.noteEvent`) stay in the GRAPH but are excluded from the agent's
    /// memory artifact. Declared `related-modules` affinities get their own
    /// section so the agent knows which docs govern which code.
    ///
    /// `.noteEvent` is NOT author-controlled the way `graph-only` is — it's
    /// graph-kit's automatic per-heading keyword classification
    /// (`classify(heading:body:)`, matching "meeting"/"standup"/"retro" in a
    /// heading), and that heading match overrides even an explicit
    /// frontmatter `type:` for that one chunk. Known limitation: a heading
    /// like "Meeting: Q3 Architecture Review" gets classified `.noteEvent`
    /// and dropped from memory even if its body holds durable architectural
    /// content — authors should avoid "meeting"/"standup"/"retro" in headings
    /// for content meant to stay in agent memory.
    public static func renderDocNotes(docCount: Int, chunks: [MemoryChunk]) -> String {
        let memoryChunks = chunks.filter { !$0.graphOnly && $0.kind != .noteEvent }
        var out = "# Documentation memory\n\n"
        out += "\(docCount) document\(docCount == 1 ? "" : "s") · "
        out += "\(memoryChunks.count) section\(memoryChunks.count == 1 ? "" : "s").\n\n"
        let byDoc = Dictionary(grouping: memoryChunks, by: \.docTitle)
        for (docTitle, docChunks) in byDoc.sorted(by: { $0.key < $1.key }) {
            out += "## \(docTitle)\n"
            for chunk in docChunks {
                out += "- \(chunk.displayHeading)\n"
            }
            out += "\n"
        }
        // Module affinity: docTitle → declared modules, deduped, sorted.
        var affinities: [(doc: String, module: String)] = []
        var seen = Set<String>()
        for chunk in memoryChunks {
            for m in chunk.relatedModules {
                let key = "\(chunk.docTitle)→\(m)"
                if seen.insert(key).inserted { affinities.append((chunk.docTitle, m)) }
            }
        }
        if !affinities.isEmpty {
            out += "## Doc ↔ module affinity\n"
            for a in affinities.sorted(by: { ($0.doc, $0.module) < ($1.doc, $1.module) }) {
                out += "- \(a.doc) → \(a.module)\n"
            }
            out += "\n"
        }
        return out
    }


}
