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

    /// Code extensions = GraphKit's structural set + the Python extension the
    /// scanner adds (`StructureScanner` unions `"py"`).
    static let codeExtensions: Set<String> = FileStructureExtractor.codeExtensions.union(["py"])

    /// Doc extensions handled by InfiniteBrain's memory generator.
    static let docExtensions: Set<String> = MemoryGenerator.supportedExtensions

    /// Classify a single file by its (lowercased) extension.
    static func kind(of url: URL) -> Kind {
        let ext = url.pathExtension.lowercased()
        if codeExtensions.contains(ext) { return .code }
        if docExtensions.contains(ext) { return .doc }
        return .other
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
