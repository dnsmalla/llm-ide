import Foundation

/// The result of one code→graph pass: the graph, the raw scan it was built
/// from, and which files were re-read.
///
/// The raw `ScanResult` is part of the contract, not an internal detail,
/// because consumers need more than the graph. The code-notes writer renders
/// per-file markdown from the symbol list, and it only rewrites the files that
/// changed — so it needs `scan` and `changedPaths`, not just `graph`. Exposing
/// them here means those consumers depend on the boundary rather than on a
/// particular engine.
public struct CodeScan: Sendable {
    /// Graph built from `scan`, with markdown already excluded (markdown
    /// belongs to the doc track).
    public let graph: CGData
    /// Files, symbols, imports and relations the scan found.
    public let scan: ScanResult
    /// Files re-parsed this run — changed plus new. Empty means everything was
    /// reused from cache.
    public let changedPaths: Set<String>
    public let totalFiles: Int
    public let reusedFiles: Int
    /// Whether `scan` is an authoritative symbol inventory for this repository.
    ///
    /// **A data-safety flag, not a hint.** An empty `scan` has two completely
    /// different meanings: "this repository genuinely contains no code files"
    /// (authoritative — anything written for it before is now stale and should
    /// be pruned) versus "this engine does not report a symbol scan at all"
    /// (not authoritative — it knows nothing about what exists).
    ///
    /// Conflating them destroys data. A plugin engine reports no symbol scan by
    /// design, so treating that as "no files" made the note writer prune every
    /// per-file note it had ever written, the first time a plugin was
    /// installed. Check this before deleting anything.
    public let reportsSymbols: Bool

    public init(graph: CGData, scan: ScanResult,
                changedPaths: Set<String> = [],
                totalFiles: Int = 0, reusedFiles: Int = 0,
                // No default: a data-safety flag must be stated. Defaulting to
                // `true` meant a future engine that simply omitted it became
                // authoritative and started pruning.
                reportsSymbols: Bool) {
        self.graph = graph
        self.scan = scan
        self.changedPaths = changedPaths
        self.totalFiles = totalFiles
        self.reusedFiles = reusedFiles
        self.reportsSymbols = reportsSymbols
    }

    /// Nothing scanned and nothing claimed — never authoritative, so it cannot
    /// be mistaken for "this repository is empty".
    public static let empty = CodeScan(graph: .empty, scan: .empty,
                                       reportsSymbols: false)
}
