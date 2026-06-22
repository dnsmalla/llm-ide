import Foundation
import GraphKit
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

    private let codeNotes: CodeNoteService
    /// Re-entrancy guard — the auto-updater (Stage 5) and a manual run must not
    /// overlap. `CodeNoteService` has its own guard too; this covers the doc
    /// track and the orchestration as a whole.
    private var isRunning = false

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
        let merged = await Task.detached(priority: .userInitiated) { () -> CGData in
            var nodes: [CGNode] = []
            var edges: [CGEdge] = []
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
            }
            return CGData(nodes: nodes, edges: edges)
        }.value
        docGraph = merged

        Self.log.info("knowledge graph generated: code=\(self.codeGraph.nodes.count, privacy: .public) doc=\(self.docGraph.nodes.count, privacy: .public) nodes")
        phase = .complete(codeNodes: codeGraph.nodes.count, docNodes: docGraph.nodes.count)
    }
}
