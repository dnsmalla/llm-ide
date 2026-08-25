import Foundation
import GraphKit
import CryptoKit
import os

/// When a repo exceeds the upload ceiling, records what was sent vs dropped.
struct CodeGraphUploadTruncation: Equatable {
    let repoPath: String
    let originalNodeCount: Int
    let originalEdgeCount: Int
    let uploadedNodeCount: Int
    let uploadedEdgeCount: Int

    var didTruncate: Bool {
        uploadedNodeCount < originalNodeCount || uploadedEdgeCount < originalEdgeCount
    }

    var summary: String {
        "Code graph upload capped at \(CodeGraphUploadService.maxNodes.formatted()) nodes / "
            + "\(CodeGraphUploadService.maxEdges.formatted()) edges — sent "
            + "\(uploadedNodeCount.formatted())/\(originalNodeCount.formatted()) nodes and "
            + "\(uploadedEdgeCount.formatted())/\(originalEdgeCount.formatted()) edges. "
            + "Agent symbol search may miss symbols in dropped regions."
    }
}

/// Ships the locally-generated structural code graph to the backend
/// (`/kb/ingest-code-graph`) so server-side agents can traverse it.
///
/// Why this exists: the Mac app builds a full symbol graph for every project it
/// graphs, but that graph never left the machine. The server's `code_graph_*`
/// tables had only one other writer — `/kb/ingest-scip`, which needs a
/// hand-produced SCIP index that nothing in the product generates — so
/// `findRelatedSymbols` returned nothing for every install, and the
/// compiler-derived half of the code-sync agent's grounding was dead weight.
///
/// Everything here is best-effort: a failed upload leaves the previous
/// server-side graph in place and is retried on the next generation. It never
/// blocks graph generation or the UI.
@MainActor
final class CodeGraphUploadService {
    /// Per-request batch sizes. The server caps a single request at 5000 nodes /
    /// 20000 edges and the transport at an 8 MB body; these sit well under both
    /// so a big repo uploads across several calls instead of being rejected.
    nonisolated static let nodesPerBatch = 1500
    nonisolated static let edgesPerBatch = 4000

    /// Whole-upload ceiling. A pathological repo shouldn't spend minutes
    /// uploading; what gets dropped is logged rather than silently discarded.
    nonisolated static let maxNodes = 40_000
    nonisolated static let maxEdges = 120_000

    weak var api: LlmIdeAPIClient?

    /// Fingerprint of the last graph successfully uploaded, per repo. The
    /// auto-updater regenerates on every timer tick and every file edit, and
    /// most of those produce an identical graph — re-uploading it would be pure
    /// waste. Only stored on SUCCESS, so a failed upload is retried next tick.
    private var lastUploaded: [String: String] = [:]

    /// Serialisation guard. A multi-batch upload sets `replace` on its FIRST
    /// batch, so two overlapping uploads would interleave: the second one's
    /// replace would delete the batches the first had already written, leaving a
    /// truncated graph on the server. The auto-updater can produce overlapping
    /// runs — `KnowledgeGraphService.generate` returns immediately when a run is
    /// already in flight, so the caller's task proceeds straight here — hence
    /// this guard rather than relying on the caller.
    private var isUploading = false
    /// Newest request received while an upload was in flight, replayed once on
    /// completion so a graph change mid-upload isn't dropped until the next tick.
    private var pending: (graph: CGData, repoRoot: URL)?

    /// Successful upload truncation state keyed by standardized repo path.
    /// Failed uploads never alter this state, because nothing was actually sent.
    private var truncationsByRepo: [String: CodeGraphUploadTruncation] = [:]

    func truncation(for repoRoot: URL) -> CodeGraphUploadTruncation? {
        truncationsByRepo[repoRoot.standardizedFileURL.path]
    }

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp",
                                                category: "CodeGraphUpload")

    init(api: LlmIdeAPIClient? = nil) {
        self.api = api
    }

    /// Content fingerprint of a graph: node ids + edge triples, hashed. Pure +
    /// static so it can be tested without a client. Node ORDER is significant
    /// only in that the builder is deterministic — the same scan produces the
    /// same order, so no sort is needed.
    nonisolated static func fingerprint(_ graph: CGData) -> String {
        var hasher = SHA256()
        for n in graph.nodes {
            hasher.update(data: Data("\(n.id)|\(n.title)|\(n.kind.rawValue)\n".utf8))
        }
        for e in graph.edges {
            hasher.update(data: Data("\(e.fromId)>\(e.toId):\(e.kind.rawValue)\n".utf8))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Split a graph into upload batches. The FIRST batch carries `replace` so
    /// one generation replaces the previous one exactly once; later batches
    /// append to it. Pure + static for testability.
    ///
    /// Nodes and edges are packed independently — a graph with few nodes and
    /// many edges (or vice versa) still fills each request rather than sending
    /// one batch per sparse slice.
    nonisolated static func batches(nodes: [CGNode], edges: [CGEdge])
        -> [(nodes: ArraySlice<CGNode>, edges: ArraySlice<CGEdge>, replace: Bool)] {
        let nodeBatches = max(1, Int(ceil(Double(nodes.count) / Double(nodesPerBatch))))
        let edgeBatches = max(1, Int(ceil(Double(edges.count) / Double(edgesPerBatch))))
        let count = max(nodeBatches, edgeBatches)
        var out: [(ArraySlice<CGNode>, ArraySlice<CGEdge>, Bool)] = []
        for i in 0..<count {
            let nLo = min(i * nodesPerBatch, nodes.count)
            let nHi = min(nLo + nodesPerBatch, nodes.count)
            let eLo = min(i * edgesPerBatch, edges.count)
            let eHi = min(eLo + edgesPerBatch, edges.count)
            out.append((nodes[nLo..<nHi], edges[eLo..<eHi], i == 0))
        }
        return out
    }

    /// Rank nodes for upload when the graph exceeds the ceiling. Prefer
    /// structural anchors (files, modules, types) and deprioritize generated or
    /// test-only regions so prefix truncation keeps agent grounding useful.
    nonisolated static func nodePriority(_ node: CGNode) -> Int {
        var score = 0
        switch node.kind {
        case .file, .module: score += 120
        case .classType, .service, .endpoint, .pipeline: score += 90
        case .function, .symbol: score += 70
        case .config, .table, .schemaNode, .resource: score += 50
        default: score += 30
        }
        let id = node.id.lowercased()
        // Graph ids carry a kind prefix (`file:Tests/...`). Treat the prefix
        // separator as a path separator so root-level Tests/ and dist/ folders
        // match the same rules as nested directories.
        let path = "/" + id.replacingOccurrences(of: ":", with: "/")
        if path.contains("/node_modules/") || path.contains("/.build/")
            || path.contains("/tests/") || path.contains("/test/")
            || path.contains("/__tests__/") || path.contains("/dist/") {
            score -= 250
        }
        if id.hasSuffix("main.swift") || id.hasSuffix("app.swift")
            || id.contains("server.mjs") || id.hasSuffix("index.ts")
            || id.hasSuffix("index.js") || id.hasSuffix("mod.rs") {
            score += 60
        }
        let depth = id.filter { $0 == "/" || $0 == ":" }.count
        score -= depth * 3
        return score
    }

    nonisolated static func edgePriority(_ edge: CGEdge) -> Int {
        switch edge.kind {
        case .imports, .contains: return 100
        case .calls, .inherits, .implements: return 80
        default: return 40
        }
    }

    /// Select the highest-value nodes/edges that fit under the upload caps.
    /// Pure + static for tests. Edges whose endpoints were dropped are excluded
    /// so the server never receives dangling references from arbitrary prefixing.
    nonisolated static func prepareForUpload(
        nodes: [CGNode],
        edges: [CGEdge],
        repoPath: String,
        maxNodes: Int = maxNodes,
        maxEdges: Int = maxEdges
    ) -> (nodes: [CGNode], edges: [CGEdge], truncation: CodeGraphUploadTruncation?) {
        guard nodes.count > maxNodes || edges.count > maxEdges else {
            return (nodes, edges, nil)
        }
        let originalNodeCount = nodes.count
        let originalEdgeCount = edges.count

        let keptNodes: [CGNode]
        if nodes.count > maxNodes {
            keptNodes = Array(nodes.sorted {
                let lp = nodePriority($0), rp = nodePriority($1)
                if lp != rp { return lp > rp }
                return $0.id < $1.id
            }.prefix(maxNodes))
        } else {
            keptNodes = nodes
        }
        let keptIds = Set(keptNodes.map(\.id))

        let viable = edges.filter { keptIds.contains($0.fromId) && keptIds.contains($0.toId) }
        let keptEdges: [CGEdge]
        if viable.count > maxEdges {
            keptEdges = Array(viable.sorted {
                let lp = edgePriority($0), rp = edgePriority($1)
                if lp != rp { return lp > rp }
                let lf = $0.fromId + ">" + $0.toId
                let rf = $1.fromId + ">" + $1.toId
                return lf < rf
            }.prefix(maxEdges))
        } else {
            keptEdges = viable
        }

        let truncation = CodeGraphUploadTruncation(
            repoPath: repoPath,
            originalNodeCount: originalNodeCount,
            originalEdgeCount: originalEdgeCount,
            uploadedNodeCount: keptNodes.count,
            uploadedEdgeCount: keptEdges.count)
        return (keptNodes, keptEdges, truncation)
    }

    /// Upload `graph` for `repoRoot` unless an identical graph was already
    /// uploaded. Returns true when a fresh upload completed.
    ///
    /// Serialised: a call made while another upload is in flight stashes its
    /// graph and returns false; the in-flight upload replays it on completion.
    @discardableResult
    func upload(graph: CGData, repoRoot: URL) async -> Bool {
        if isUploading {
            pending = (graph, repoRoot)
            return false
        }
        isUploading = true
        let uploaded = await performUpload(graph: graph, repoRoot: repoRoot)
        isUploading = false
        if let next = pending {
            pending = nil
            // Fingerprint-deduped, so replaying an unchanged graph is a no-op.
            await upload(graph: next.graph, repoRoot: next.repoRoot)
        }
        return uploaded
    }

    private func performUpload(graph: CGData, repoRoot: URL) async -> Bool {
        guard let api else { return false }
        // An empty graph is never uploaded: a scan that produced nothing (a
        // transient git failure, a project mid-clone) must not `replace` a good
        // server-side graph with nothing.
        guard !graph.nodes.isEmpty else { return false }

        let repoPath = repoRoot.standardizedFileURL.path
        let fp = Self.fingerprint(graph)
        if lastUploaded[repoPath] == fp { return false }

        let prepared = Self.prepareForUpload(nodes: graph.nodes, edges: graph.edges, repoPath: repoPath)
        let nodes = prepared.nodes
        let edges = prepared.edges
        if let truncation = prepared.truncation {
            Self.log.notice("""
                code graph exceeds upload ceiling for \(repoRoot.lastPathComponent, privacy: .public) — \
                sending \(truncation.uploadedNodeCount, privacy: .public)/\(truncation.originalNodeCount, privacy: .public) nodes, \
                \(truncation.uploadedEdgeCount, privacy: .public)/\(truncation.originalEdgeCount, privacy: .public) edges (priority-selected)
                """)
        }

        do {
            // The graphed repo is often `code/<child>`, while only the workspace
            // root gets allow-listed on project open — so register it here. Same
            // idempotent call AppShell already makes before connect-git.
            _ = try await api.addUserRepo(path: repoPath)
            var uploadedNodes = 0
            var uploadedEdges = 0
            for batch in Self.batches(nodes: nodes, edges: edges) {
                let result = try await api.ingestCodeGraph(repoPath: repoPath,
                                                           nodes: Array(batch.nodes),
                                                           edges: Array(batch.edges),
                                                           replace: batch.replace)
                uploadedNodes += result.nodes
                uploadedEdges += result.edges
                if result.droppedNodes > 0 || result.droppedEdges > 0 {
                    Self.log.notice("server dropped \(result.droppedNodes, privacy: .public) nodes / \(result.droppedEdges, privacy: .public) edges as malformed")
                }
            }
            lastUploaded[repoPath] = fp
            if let truncation = prepared.truncation {
                truncationsByRepo[repoPath] = truncation
            } else {
                truncationsByRepo.removeValue(forKey: repoPath)
            }
            Self.log.info("uploaded code graph: \(uploadedNodes, privacy: .public) nodes / \(uploadedEdges, privacy: .public) edges for \(repoRoot.lastPathComponent, privacy: .public)")
            return true
        } catch {
            // Don't record the fingerprint — the next generation retries.
            Self.log.warning("code graph upload failed for \(repoRoot.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Forget the per-repo fingerprints so the next generation re-uploads in
    /// full. Used when the server-side graph may no longer match (sign-out /
    /// server change).
    func reset() {
        lastUploaded.removeAll()
        truncationsByRepo.removeAll()
    }
}
