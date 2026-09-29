import Foundation
import GraphCore

/// Routes a project's files to the right graph generator by file extension —
/// the first stage of the unified knowledge graph:
///
///   • code-extension files  → the Code graph   (CodeNoteService / StructureScanner)
///   • doc-extension files    → InfiniteBrain    (GraphKit.MemoryGenerator)
///
/// The extension sets are sourced from GraphKit so this stays in lock-step with
/// what each generator actually parses (the scanner unions "py" on top of
/// `FileStructureExtractor.codeExtensions`; MemoryGenerator exposes its own
/// supported doc extensions).
enum FileClassifier {

    /// Doc extensions — the shared convention from `GraphCore`, not the
    /// engine's copy, so this type carries no dependency on a graph engine and
    /// keeps working when one is not installed.
    static let docExtensions: Set<String> = DocExtensions.markdownAndText

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

    /// The doc→code **citation overlay** of a RAW (unstripped) code graph: the
    /// doc FILE nodes (`.docPage` with a `file:` id — never a heading) that
    /// cite code, plus their `references` edges whose target survives
    /// `strippingDocNodes`. A doc→doc link is left out (its target is
    /// stripped), and so is a doc whose citations all point at stripped nodes.
    ///
    /// Why it exists: stripping removes every edge touching a `.docPage`, so
    /// graph-kit's doc→code citation edges never reached the server's
    /// find-code ("documented by"). The views keep rendering the stripped
    /// graph (no double counting in "All"); only the upload payload merges
    /// this back in (`mergingCitationOverlay`).
    static func citationOverlay(from graph: CGData) -> CGData {
        let docFiles = Dictionary(
            graph.nodes.filter { $0.kind == .docPage && $0.id.hasPrefix("file:") }.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first })
        guard !docFiles.isEmpty else { return .empty }
        let surviving = Set(strippingDocNodes(from: graph).nodes.map(\.id))
        let edges = graph.edges.filter {
            $0.kind == .references && docFiles[$0.fromId] != nil && surviving.contains($0.toId)
        }
        guard !edges.isEmpty else { return .empty }
        var seen = Set<String>()
        let nodes = edges.compactMap { e -> CGNode? in
            guard seen.insert(e.fromId).inserted else { return nil }
            return docFiles[e.fromId]
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// The graph the backend upload receives: the stripped `code` graph plus
    /// `overlay`'s doc nodes and those citation edges whose target is in
    /// `code`. Never used for rendering.
    static func mergingCitationOverlay(_ overlay: CGData, into code: CGData) -> CGData {
        guard !overlay.edges.isEmpty else { return code }
        let codeIds = Set(code.nodes.map(\.id))
        let edges = overlay.edges.filter { codeIds.contains($0.toId) && !codeIds.contains($0.fromId) }
        guard !edges.isEmpty else { return code }
        let sources = Set(edges.map(\.fromId))
        let nodes = overlay.nodes.filter { sources.contains($0.id) }
        return CGData(nodes: code.nodes + nodes, edges: code.edges + edges)
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

}
