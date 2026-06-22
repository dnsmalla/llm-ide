import Foundation
import GraphKit
import CryptoKit
import os

/// Stage 1 of the unified knowledge graph
/// (docs/superpowers/plans/2026-06-22-unified-knowledge-graph-automation.md):
/// run BOTH generators for a project and expose both `CGData` outputs —
///
///   • code track → `CodeNoteService` (StructureScanner; filters code extensions
///     internally, incremental via scan-cache, also writes `system/graph/`)
///   • doc  track → `GraphKit.MemoryGenerator` over the project's doc folders
///
/// Merging the two into one graph (Stage 2), incremental doc caching (Stage 3),
/// agent-facing memory output (Stage 4), and automatic triggering (Stage 5) build
/// on this. Kept free of any view/selection state so the later automation can
/// drive it headlessly.
@MainActor
final class KnowledgeGraphService: ObservableObject {
    enum Phase: Equatable {
        case idle
        case running
        case complete(codeNodes: Int, docNodes: Int)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    /// The structural code graph (file + symbol nodes).
    @Published private(set) var codeGraph: CGData = .empty
    /// The InfiniteBrain doc/memory graph (doc + chunk nodes).
    @Published private(set) var docGraph: CGData = .empty
    /// Code + doc unified into one graph, with doc→code cross-links (Stage 2).
    @Published private(set) var mergedGraph: CGData = .empty

    private let codeNotes: CodeNoteService
    /// Re-entrancy guard — the auto-updater (Stage 5) and a manual run must not
    /// overlap. `CodeNoteService` has its own guard too; this covers the doc
    /// track and the orchestration as a whole.
    private var isRunning = false

    // Stage 3 — doc-track change detection. The doc graph is recomputed only
    // when the doc set's fingerprint changes; otherwise the cached result is
    // reused. (The code track is incremental per-file via CodeNoteService's
    // own scan-cache.) Per-instance/in-session; the Stage 5 auto-updater holds
    // a long-lived instance, so a periodic refresh that finds no doc change is
    // near-free. Reset on project switch.
    private var lastDocFingerprint: String?
    private var cachedDocGraph: CGData = .empty
    private var cachedChunks: [MemoryChunk] = []

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp",
                                                category: "KnowledgeGraphService")

    // No default-arg `CodeNoteService()` — a default argument is evaluated in a
    // nonisolated context, but CodeNoteService's init is @MainActor-isolated.
    // Construct it inside this @MainActor init instead.
    init() {
        self.codeNotes = CodeNoteService()
    }

    /// Run both tracks for a project.
    /// - Parameters:
    ///   - codeRepoRoot: the git repo to scan for code (nil skips the code track).
    ///   - docRoots: folders whose docs feed InfiniteBrain (typically the
    ///     project's `notes/` and `data/` dirs). Missing folders are skipped.
    func generate(codeRepoRoot: URL?, docRoots: [URL]) async {
        if isRunning { return }
        isRunning = true
        defer { isRunning = false }
        phase = .running

        // Code track — StructureScanner filters to code extensions internally
        // and is incremental (scan-cache), so this is cheap on re-runs.
        if let codeRepoRoot {
            _ = await codeNotes.generate(repoRoot: codeRepoRoot)
            codeGraph = codeNotes.graph
        }

        // Doc track — MemoryGenerator walks each root (bounded) and filters to
        // doc extensions. Pure text chunking (no LLM), run off the main actor.
        let roots = docRoots
        // Recompute the doc graph only when the doc set changed (stat-only
        // fingerprint); otherwise reuse the cached result.
        let fingerprint = await Task.detached(priority: .utility) { Self.docSetFingerprint(roots: roots) }.value
        let doc: (graph: CGData, chunks: [MemoryChunk])
        if let last = lastDocFingerprint, last == fingerprint {
            doc = (cachedDocGraph, cachedChunks)
        } else {
            doc = await Task.detached(priority: .userInitiated) { () -> (graph: CGData, chunks: [MemoryChunk]) in
                var nodes: [CGNode] = []
                var edges: [CGEdge] = []
                var chunks: [MemoryChunk] = []
                var seenNode = Set<String>()
                let fm = FileManager.default
                for root in roots {
                    var isDir: ObjCBool = false
                    guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else { continue }
                    let mem = MemoryGenerator.generate(from: root)
                    for n in mem.graph.nodes where seenNode.insert(n.id).inserted { nodes.append(n) }
                    // CGEdge has no id; doc graphs from distinct roots have disjoint
                    // (path-hashed) node ids, so their edges can't collide — append.
                    edges.append(contentsOf: mem.graph.edges)
                    chunks.append(contentsOf: mem.chunks)
                }
                return (CGData(nodes: nodes, edges: edges), chunks)
            }.value
            lastDocFingerprint = fingerprint
            cachedDocGraph = doc.graph
            cachedChunks = doc.chunks
        }
        docGraph = doc.graph

        // Stage 2 — unify code + doc into one graph, with doc→code cross-links.
        mergedGraph = Self.merge(code: codeGraph, doc: doc.graph, chunks: doc.chunks)

        Self.log.info("knowledge graph: code=\(self.codeGraph.nodes.count, privacy: .public) doc=\(self.docGraph.nodes.count, privacy: .public) merged=\(self.mergedGraph.nodes.count, privacy: .public) nodes / \(self.mergedGraph.edges.count, privacy: .public) edges")
        phase = .complete(codeNodes: codeGraph.nodes.count, docNodes: docGraph.nodes.count)
    }

    /// Merge the code and doc graphs into one and add doc→code cross-links:
    /// a doc chunk that names a code symbol — via an explicit `[[wikilink]]` or
    /// an exact (case-insensitive) title match — gets a `references` edge to
    /// that code node. Conservative on purpose (explicit links + exact titles
    /// only) so we don't manufacture false edges; fuzzy body-mention matching
    /// is a later refinement. Node ids are namespaced (code paths/symbols vs
    /// `doc:`/chunk hashes) so the union can't collide; chunk graph-node ids
    /// equal `MemoryChunk.id`, so the cross-link `fromId` resolves to a real node.
    nonisolated static func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) -> CGData {
        var nodes: [CGNode] = []
        var seen = Set<String>()
        for n in code.nodes + doc.nodes where seen.insert(n.id).inserted { nodes.append(n) }
        var edges = code.edges + doc.edges

        // Index code nodes by lowercased title for name matching.
        var codeIdsByTitle: [String: [String]] = [:]
        for n in code.nodes { codeIdsByTitle[n.title.lowercased(), default: []].append(n.id) }
        guard !codeIdsByTitle.isEmpty else { return CGData(nodes: nodes, edges: edges) }

        var crossSeen = Set<String>()
        for chunk in chunks {
            var names = chunk.wikiLinks.map { $0.lowercased() }
            names.append(chunk.title.lowercased())
            for name in names {
                guard let targets = codeIdsByTitle[name] else { continue }
                for codeId in targets {
                    let key = "\(chunk.id)->\(codeId)"
                    guard crossSeen.insert(key).inserted else { continue }
                    edges.append(CGEdge(fromId: chunk.id, toId: codeId,
                                        kind: .references, confidence: .inferred))
                }
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// Clear the doc-track cache — call on project switch so a new project
    /// doesn't reuse the previous project's doc graph.
    func resetCache() {
        lastDocFingerprint = nil
        cachedDocGraph = .empty
        cachedChunks = []
    }

    /// Cheap change signal for the doc set: sorted `path|size|mtime` over every
    /// doc-extension file under the roots, hashed. Stat-only (no file reads),
    /// so re-running when nothing changed is near-free; the doc track recomputes
    /// only when a doc is added, removed, or edited.
    nonisolated static func docSetFingerprint(roots: [URL]) -> String {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        var entries: [String] = []
        for root in roots {
            guard let en = fm.enumerator(at: root, includingPropertiesForKeys: keys,
                                         options: [.skipsHiddenFiles]) else { continue }
            for case let url as URL in en {
                guard FileClassifier.docExtensions.contains(url.pathExtension.lowercased()) else { continue }
                let vals = try? url.resourceValues(forKeys: Set(keys))
                guard vals?.isRegularFile == true else { continue }
                let size = vals?.fileSize ?? 0
                let mtime = vals?.contentModificationDate?.timeIntervalSince1970 ?? 0
                entries.append("\(url.path)|\(size)|\(mtime)")
            }
        }
        entries.sort()
        let digest = SHA256.hash(data: Data(entries.joined(separator: "\n").utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
