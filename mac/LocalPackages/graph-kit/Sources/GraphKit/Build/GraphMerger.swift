import Foundation
import GraphCore

/// Joins the code and doc tracks into one graph, adding doc→code cross-links.
///
/// This is engine logic and lives in GraphKit — not in the app's
/// `BuiltinGraphEngine`, which is required to stay a thin adapter: anything
/// real written into the adapter becomes logic the app silently loses the day
/// the engine is unplugged, and logic the TypeScript implementation can never
/// see to stay in step with.
public enum GraphMerger {

    /// Merge the code and doc graphs, adding doc→code cross-links by two
    /// mechanisms: explicit `[[wikilinks]]` from a chunk to a code symbol, and
    /// inline backtick mentions resolved against a code inventory via
    /// `DocCodeLinker`. A chunk's heading-derived title is deliberately NOT
    /// matched, because generic headings ("Config", "Setup", "main") collide
    /// with symbol names and would manufacture false edges.
    ///
    /// Node ids are namespaced (code paths/symbols vs `doc:`/chunk hashes) so
    /// the union cannot collide, and a chunk's graph-node id equals its
    /// `MemoryChunk.id`, so a cross-link's `fromId` resolves to a real node.
    public static func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) -> CGData {
        var nodes: [CGNode] = []
        var seen = Set<String>()
        for node in code.nodes + doc.nodes where seen.insert(node.id).inserted {
            nodes.append(node)
        }
        var edges = code.edges + doc.edges

        var codeIdsByTitle: [String: [String]] = [:]
        for node in code.nodes {
            codeIdsByTitle[node.title.lowercased(), default: []].append(node.id)
        }
        guard !codeIdsByTitle.isEmpty else {
            return CGData(nodes: nodes, edges: edges,
                          layers: code.layers + doc.layers,
                          tour: code.tour + doc.tour)
        }

        var crossSeen = Set<String>()
        for chunk in chunks {
            for name in chunk.wikiLinks.map({ $0.lowercased() }) {
                guard let targets = codeIdsByTitle[name] else { continue }
                for codeId in targets where crossSeen.insert("\(chunk.id)->\(codeId)").inserted {
                    edges.append(CGEdge(fromId: chunk.id, toId: codeId,
                                        kind: .references, confidence: .extracted))
                }
            }
        }

        // Mention links. Inventory keys are node titles plus any explicit
        // relative-path metadata, lowercased. No separate basename key is
        // needed: `StructureGraphBuilder` always titles a `.file` node with the
        // path's basename, so a basename mention already hits `codeIdsByTitle`.
        var inventory = codeIdsByTitle
        for node in code.nodes {
            if let path = node.metadata["source_file"]?.lowercased(), inventory[path] == nil {
                inventory[path, default: []].append(node.id)
            }
        }
        // Declared module affinity: frontmatter `related-modules:` is the one
        // author-asserted, high-precision doc→code signal in the system, and
        // until now it produced ZERO edges — it was parsed, listed in
        // doc-notes.md, and never linked, while the noisy backtick heuristic
        // below produced thousands. That inversion is a measured part of why a
        // real repo's doc chunks arrived fully disconnected from its code
        // (129 components, every one of 1589 chunks outside the code
        // component).
        //
        // A declared module is a path or path prefix. Link the chunk to the
        // code FILE nodes under it, capped and sorted so a directory
        // declaration cannot become an unbounded hub.
        var fileIdsByPath: [(path: String, id: String)] = []
        for node in code.nodes where node.kind == .file {
            if let path = node.metadata["source_file"]?.lowercased() {
                fileIdsByPath.append((path, node.id))
            }
        }
        fileIdsByPath.sort { $0.path < $1.path }
        let maxFilesPerModule = 8
        // Fan-IN cap. Fan-out is capped per chunk, but when every chunk in a
        // docs-heavy repo declares the same module (a template, or a shared
        // convention like `related-modules: extension/kb`), the 8 files under
        // it absorb one edge from EVERY chunk — measured at 1589 chunks that
        // gave those files a 32× repulsion mass over every other node and
        // pinned their PageRank at 1.0, which is the hub-domination failure
        // the layout work removed, reintroduced through a new edge source.
        // The first `maxChunksPerFile` chunks (input order, which is document
        // order — deterministic) keep the link; the signal stays, the
        // asymmetry is bounded.
        let maxChunksPerFile = 32
        var fanIn: [String: Int] = [:]

        for chunk in chunks {
            for module in chunk.relatedModules {
                guard let prefix = normalizeModulePrefix(module) else { continue }
                var linked = 0
                for (path, id) in fileIdsByPath {
                    guard linked < maxFilesPerModule else { break }
                    guard path == prefix || path.hasPrefix(prefix + "/") else { continue }
                    guard fanIn[id, default: 0] < maxChunksPerFile else { continue }
                    guard crossSeen.insert("\(chunk.id)->\(id)").inserted else { continue }
                    // `.documents` — the chunk documents that module — at
                    // `.extracted`: the author stated it, nothing was inferred.
                    edges.append(CGEdge(fromId: chunk.id, toId: id,
                                        kind: .documents, confidence: .extracted))
                    fanIn[id, default: 0] += 1
                    linked += 1
                }
            }
        }

        for link in DocCodeLinker.links(chunks: chunks, inventory: inventory) {
            guard crossSeen.insert("\(link.chunkID)->\(link.codeNodeID)").inserted else { continue }
            // `DocCodeLinker` scores a mention 0.9 when it is path-shaped and
            // 0.7 when it is only symbol-shaped. Both are heuristics over
            // surface text, so both map to `.inferred`; an author-asserted
            // wikilink above is `.extracted`. Preserving the numeric score
            // needs a confidence tier the canonical schema does not have.
            edges.append(CGEdge(fromId: link.chunkID, toId: link.codeNodeID,
                                kind: .references, confidence: .inferred))
        }
        // Carry layers/tour through — every previous transform in this pipeline
        // dropped them by constructing `CGData(nodes:edges:)`.
        return CGData(nodes: nodes, edges: edges,
                      layers: code.layers + doc.layers,
                      tour: code.tour + doc.tour)
    }
    /// Normalise a declared module path to the repo-relative prefix the code
    /// inventory uses.
    ///
    /// Authors write modules in several natural forms — `kb`, `kb/`, `./kb`,
    /// `kb/*`, `kb/**` — and before normalisation everything but the first two
    /// silently produced zero edges, which is the exact silent-zero failure
    /// this feature exists to close. Matching is case-insensitive to mirror the
    /// rest of the inventory (right on APFS's default case-insensitivity;
    /// documented on `MemoryChunk.relatedModules`).
    ///
    /// Returns nil for forms that cannot name a repo path (empty, `.`,
    /// anything with `..` — resolving parent references against an unknown
    /// base would guess).
    public static func normalizeModulePrefix(_ module: String) -> String? {
        var prefix = module.lowercased().trimmingCharacters(in: .whitespaces)
        if prefix.hasPrefix("./") { prefix.removeFirst(2) }
        for suffix in ["/**", "/*"] where prefix.hasSuffix(suffix) {
            prefix.removeLast(suffix.count)
        }
        prefix = prefix.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !prefix.isEmpty, prefix != ".",
              !prefix.split(separator: "/").contains("..")
        else { return nil }
        return prefix
    }
}
