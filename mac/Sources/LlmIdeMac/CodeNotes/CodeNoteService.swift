import Foundation
import GraphKit
import Combine
import os

/// Generates the code graph + deterministic notes from a repository.
/// No AI: the graph and notes are derived directly from structural facts
/// (git ls-files + Swift/TS/JS line parsing + Python AST). Incremental —
/// only files whose content hash changed since the last run are re-parsed,
/// so regeneration cost scales with the diff, not the whole repo.
///
///   <repo>/system/graph/
///     index.md        ← whole-repo summary ranked by impact
///     graph.json      ← machine-readable adjacency list
///     notes/          ← one deterministic .md per code file
///     scan-cache.json ← per-file hash + structure (incremental cache)
@MainActor
public final class CodeNoteService: ObservableObject {
    public enum Progress: Equatable {
        case idle
        case scanning
        case buildingGraph
        /// `reused` = files served from cache (skipped re-parse).
        case complete(files: Int, edges: Int, reused: Int)
        case failed(String)
    }

    @Published public private(set) var progress: Progress = .idle
    /// The current graph (file + symbol nodes). Published so the UI re-renders.
    @Published public private(set) var graph: CGData = .empty

    private let launcher: ProcessLauncher
    /// CLI used to enrich notes in the background after the structural skeleton
    /// is built. When nil (the default), generation stops at the deterministic
    /// skeleton and no agent is invoked.
    private let cliExecutable: URL?

    /// Guards against overlapping runs (a manual click racing the auto-updater,
    /// or two rapid clicks). Both would write the same scan-cache / notes
    /// concurrently. @MainActor-isolated, so the check + set is atomic.
    private var isRunning = false

    /// Cross-INSTANCE guard keyed by repo path. UAGraphView owns its own
    /// CodeNoteService and GraphAutoUpdater owns another, so the per-instance
    /// `isRunning` can't see the other — yet both write the same
    /// `<repoRoot>/system/graph` dir. Serialize by path so a manual run and an
    /// auto run for the same repo can't interleave their multi-file writes.
    @MainActor private static var inFlightPaths: Set<String> = []

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp", category: "CodeNoteService")

    public init(launcher: ProcessLauncher = SystemProcessLauncher(),
                cliExecutable: URL? = nil) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
    }

    /// Scan the repo (incrementally), build the graph, write deterministic
    /// notes + index.md + graph.json. Returns the file+symbol graph.
    public func generate(repoRoot: URL) async -> Result<CGData, CodeNoteError> {
        // No-op if a run is already in flight (auto-updater vs manual click, or
        // double-click) — returning the current graph avoids a concurrent write
        // to the same scan-cache / notes dir.
        let pathKey = repoRoot.standardizedFileURL.path
        if isRunning || Self.inFlightPaths.contains(pathKey) { return .success(graph) }
        isRunning = true
        Self.inFlightPaths.insert(pathKey)
        defer { isRunning = false; Self.inFlightPaths.remove(pathKey) }
        guard FileManager.default.fileExists(atPath: repoRoot.path) else {
            progress = .failed("folder not found")
            return .failure(.folderNotWritable(path: repoRoot.path))
        }
        let launcher = self.launcher

        // Phase 1 — scan (off the main actor).
        progress = .scanning
        let inc = await Task.detached(priority: .userInitiated) {
            await StructureScanner(launcher: launcher).scanIncremental(repoRoot: repoRoot)
        }.value
        if Task.isCancelled { progress = .idle; return .failure(.cancelled) }

        // Phase 2 — build graph + write notes (off the main actor).
        progress = .buildingGraph
        let result = inc.result
        let graph = await Task.detached(priority: .userInitiated) { () -> CGData in
            let g = StructureGraphBuilder.build(result, repoRoot: repoRoot)
            CodeNoteGenerator.generate(scan: result, repoRoot: repoRoot,
                                       changedPaths: inc.changedPaths)
            return g
        }.value
        if Task.isCancelled { progress = .idle; return .failure(.cancelled) }

        // Publish on the main actor.
        self.graph = graph
        progress = .complete(files: result.files.count,
                             edges: graph.edges.count,
                             reused: inc.reusedFiles)

        // Background enrichment: only when a CLI is configured and files changed.
        // Fire-and-forget — the skeleton above is already the returned result.
        if let cli = cliExecutable, !inc.changedPaths.isEmpty {
            let changed = inc.changedPaths
            Task.detached(priority: .utility) {
                let files = result.files.map(\.path).filter { changed.contains($0) }
                let batches = BatchPlanner.plan(files: files, imports: result.imports,
                                                maxBatchSize: 8)
                let phase = AnalyzePhase(launcher: launcher, cliExecutable: cli)
                for batch in batches {
                    if case .failure(let err) = await phase.run(batch: batch, scan: result,
                                                                repoRoot: repoRoot) {
                        Self.log.error("note enrichment batch \(batch.index) failed: \(String(describing: err))")
                    }
                }
            }
        }
        return .success(graph)
    }
}
