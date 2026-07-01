import Foundation
import GraphKit

/// Routes a project's files to the right graph generator by file extension —
/// the first stage of the unified knowledge graph (see
/// docs/superpowers/plans/2026-06-22-unified-knowledge-graph-automation.md):
///
///   • code-extension files  → the Code graph   (CodeNoteService / StructureScanner)
///   • doc-extension files    → InfiniteBrain    (GraphKit.MemoryGenerator)
///
/// The extension sets are sourced from GraphKit so this stays in lock-step with
/// what each generator actually parses (the scanner unions "py" on top of
/// `FileStructureExtractor.codeExtensions`; MemoryGenerator exposes its own
/// supported doc extensions).
enum FileClassifier {
    enum Kind: Equatable { case code, doc, other }

    /// Doc extensions handled by InfiniteBrain's memory generator.
    static let docExtensions: Set<String> = MemoryGenerator.supportedExtensions

    /// Code extensions = GraphKit's structural set + the Python extension the
    /// scanner adds (`StructureScanner` unions `"py"`) — MINUS anything we treat
    /// as a doc. GraphKit's structural set includes `"md"` (it can pull headings
    /// out of markdown), but markdown is a *doc*: it belongs to InfiniteBrain,
    /// not the code graph. Subtracting `docExtensions` keeps `kind()` (which
    /// checks code first) from misrouting markdown to the code track.
    static let codeExtensions: Set<String> =
        FileStructureExtractor.codeExtensions.union(["py"]).subtracting(docExtensions)

    /// Classify a single file by its (lowercased) extension.
    static func kind(of url: URL) -> Kind {
        let ext = url.pathExtension.lowercased()
        if docExtensions.contains(ext) { return .doc }
        if codeExtensions.contains(ext) { return .code }
        return .other
    }

    /// Remove code-track markdown from a code graph.
    ///
    /// The GraphKit scanner still ingests markdown files (it emits them as
    /// `.docPage` nodes, with their `##` headings as symbols it `.contains`).
    /// Since "md is doc", that markdown belongs to the InfiniteBrain track only —
    /// leaving it in the code graph double-counts every doc in "All" (once as a
    /// code `.docPage`, once as a doc `.memoryDoc`). Strip the `.docPage` nodes
    /// and everything they contain so markdown reaches the graph solely via the
    /// doc generator. `.docPage` is emitted *only* for markdown by the code
    /// scanner, so this never touches real source nodes.
    static func strippingDocNodes(from graph: CGData) -> CGData {
        let docPageIds = Set(graph.nodes.filter { $0.kind == .docPage }.map(\.id))
        guard !docPageIds.isEmpty else { return graph }
        var removeIds = docPageIds
        for e in graph.edges where e.kind == .contains && docPageIds.contains(e.fromId) {
            removeIds.insert(e.toId)
        }
        let nodes = graph.nodes.filter { !removeIds.contains($0.id) }
        let edges = graph.edges.filter { !removeIds.contains($0.fromId) && !removeIds.contains($0.toId) }
        return CGData(nodes: nodes, edges: edges)
    }

    /// Node kinds the doc/InfiniteBrain track emits: `MemoryGenerator` produces
    /// `memoryDoc`/`memoryChunk` plus the vault `note*` kinds (see its
    /// `kindFromTypeString`/`classify`), and markdown enters as `docPage`.
    /// Everything else in a graph this app builds is code structure
    /// (`file`/`symbol`/`module` from `StructureGraphBuilder`). The richer
    /// `CGNodeKind` cases (`function`, `entity`, `domain`, …) belong to other
    /// GraphKit consumers, not this app's two tracks — so `nodeCounts` buckets
    /// any non-doc kind as code rather than enumerate kinds we never emit.
    static let docNodeKinds: Set<CGNodeKind> = [
        .docPage, .memoryDoc, .memoryChunk,
        .noteDecision, .noteTask, .noteQuestion, .noteFact, .noteConcept,
        .notePlaybook, .noteHypothesis, .noteEvent, .noteSource,
    ]

    /// Split graph nodes into doc (`docNodeKinds`) vs code (everything else)
    /// counts — the "N code · M doc" breakdown for the graph status badge.
    static func nodeCounts(_ nodes: [CGNode]) -> (code: Int, doc: Int) {
        var code = 0, doc = 0
        for n in nodes {
            if docNodeKinds.contains(n.kind) { doc += 1 } else { code += 1 }
        }
        return (code, doc)
    }

    /// Partition a flat file list into code / doc URLs, dropping everything else.
    static func partition(_ files: [URL]) -> (code: [URL], doc: [URL]) {
        var code: [URL] = []
        var doc: [URL] = []
        for f in files {
            switch kind(of: f) {
            case .code:  code.append(f)
            case .doc:   doc.append(f)
            case .other: break
            }
        }
        return (code, doc)
    }
}
