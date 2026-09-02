#if GRAPHKIT_BUILTIN
import Foundation
import GraphCore
import GraphKit

/// The compiled-in graph engine: a thin adapter over the vendored `GraphKit`
/// producers.
///
/// **This is the only file in the app that imports `GraphKit`.** Removing the
/// `graph-kit` package from `mac/Package.swift` makes `canImport(GraphKit)`
/// false, this whole file compiles away, and `GraphEngineRegistry` falls back to
/// a plugin-provided engine (or reports that none is installed). Nothing else
/// has to change — which is the property the whole `GraphCore`/`GraphKit` split
/// exists to guarantee, and it is verifiable by deleting that one line and
/// building.
///
/// Keep this file an adapter. Any real logic added here becomes logic the app
/// loses when the engine is unplugged, so it belongs either in `GraphKit`
/// (production) or in `GraphCore` (model, layout, shared conventions).
public struct BuiltinGraphEngine: GraphEngine {

    public let identifier = "builtin"
    public let displayName = "Built-in (GraphKit)"
    public var supportedDocExtensions: Set<String> { MemoryGenerator.supportedExtensions }

    // MARK: - Code → graph

    public func scanCode(repoRoot: URL) async throws -> CodeScan {
        let incremental = await StructureScanner(launcher: SystemProcessLauncher())
            .scanIncremental(repoRoot: repoRoot)
        let graph = StructureGraphBuilder.build(incremental.result, repoRoot: repoRoot)
        // "md is doc": the code scanner also ingests markdown as `.docPage`
        // nodes. Leaving them in double-counts every document once the two
        // tracks are merged, so they are stripped here — the engine owns this
        // because it is the engine that chose to emit them.
        return CodeScan(graph: FileClassifier.strippingDocNodes(from: graph),
                        scan: incremental.result,
                        changedPaths: incremental.changedPaths,
                        totalFiles: incremental.totalFiles,
                        reusedFiles: incremental.reusedFiles,
                        // This scanner enumerates the repository itself, so an
                        // empty result really does mean "no code files here".
                        reportsSymbols: true)
    }

    // MARK: - Docs → graph

    public func generateDocMemory(roots: [URL]) async throws -> GeneratedMemory {
        await Task.detached(priority: .userInitiated) {
            var nodes: [CGNode] = []
            var edges: [CGEdge] = []
            var chunks: [MemoryChunk] = []
            var docCount = 0
            var seen = Set<String>()
            let fm = FileManager.default

            for root in roots {
                var isDirectory: ObjCBool = false
                guard fm.fileExists(atPath: root.path, isDirectory: &isDirectory),
                      isDirectory.boolValue else { continue }
                let memory = MemoryGenerator.generate(from: root)
                for node in memory.graph.nodes where seen.insert(node.id).inserted {
                    nodes.append(node)
                }
                // `CGEdge` has no identity, and doc graphs from distinct roots
                // have disjoint path-hashed node ids, so their edges cannot
                // collide — append without de-duplicating.
                edges.append(contentsOf: memory.graph.edges)
                chunks.append(contentsOf: memory.chunks)
                docCount += memory.docCount
            }
            return GeneratedMemory(graph: CGData(nodes: nodes, edges: edges),
                                   chunks: chunks, docCount: docCount)
        }.value
    }

    public func generateDocMemory(files: [URL]) async throws -> GeneratedMemory {
        await Task.detached(priority: .userInitiated) {
            MemoryGenerator.generate(files: files)
        }.value
    }

    /// Stat-only signature of the document set, so re-running when nothing
    /// changed is near-free.
    ///
    /// The walk MUST mirror `MemoryGenerator.collectDocs` — same extension set,
    /// same size cap, same file cap, and crucially the same `ExcludedDirs`
    /// pruning. That is why this lives in the engine rather than in the app:
    /// it encodes the engine's own ingestion rules, and drifting from them
    /// broke the cache in both directions. Omitting the exclusions once meant
    /// the fingerprint covered files the generator never reads:
    ///
    ///   * every regen rewrites the generated notes under `system/`, all of
    ///     them doc-extension files, so the fingerprint changed on EVERY run
    ///     and the cache never hit;
    ///   * those generated notes plus `node_modules` READMEs could fill the
    ///     500-entry cap before the walk reached a real doc, so an actual doc
    ///     edit left the fingerprint unchanged and the graph went stale.
    public func docSetFingerprint(roots: [URL]) -> String {
        let maxFiles = 500
        let maxFileBytes = 2_000_000
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey,
                                      .isRegularFileKey]
        var entries: [String] = []
        outer: for root in roots {
            // `skipsPackageDescendants` matters: a doc inside a `.bundle` would
            // otherwise flip the fingerprint without ever changing output.
            guard let walker = fm.enumerator(
                at: root, includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in walker {
                if let name = url.pathComponents.last, ExcludedDirs.names.contains(name) {
                    walker.skipDescendants(); continue
                }
                guard supportedDocExtensions.contains(url.pathExtension.lowercased())
                else { continue }
                let values = try? url.resourceValues(forKeys: Set(keys))
                guard values?.isRegularFile == true else { continue }
                let size = values?.fileSize ?? 0
                guard size <= maxFileBytes else { continue }
                let modified = values?.contentModificationDate?.timeIntervalSince1970 ?? 0
                entries.append("\(url.path)|\(size)|\(modified)")
                if entries.count >= maxFiles { break outer }
            }
        }
        entries.sort()
        return Fingerprint.hash(of: Data(entries.joined(separator: "\n").utf8))
    }

    // MARK: - Join

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
    public func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) async throws -> CGData {
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
}
#endif
