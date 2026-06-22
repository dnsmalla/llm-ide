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
