import Foundation
import GraphCore
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
///     <path>.md       ← one deterministic note per code file (directly under system/graph/)
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
    /// Produces the scan this service turns into notes. Injected rather than
    /// constructed so the app never names a producer type outside
    /// `GraphGeneration/` — see `GraphEngine`. nil means no engine is installed,
    /// in which case generation reports that rather than scanning nothing.
    private let engine: GraphEngine?
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

    /// `launcher` drives the note-enrichment CLI only. The scan's launcher is
    /// the engine's own business — a plugin engine is a subprocess and has no
    /// `ProcessLauncher` to inject. Keeping the parameter would imply the scan
    /// is still injectable when it is not.
    public init(launcher: ProcessLauncher = SystemProcessLauncher(),
                engine: GraphEngine? = GraphEngines.resolveDefault(),
                cliExecutable: URL? = nil) {
        self.launcher = launcher
        self.engine = engine
        self.cliExecutable = cliExecutable
    }

    /// Scan the repo (incrementally), build the graph, write deterministic
    /// notes + index.md + graph.json. Returns the file+symbol graph.
    public func generate(repoRoot: URL) async -> Result<CGData, CodeNoteError> {
        // No-op if a run is already in flight (auto-updater vs manual click, or
        // double-click) — returning the current graph avoids a concurrent write
        // to the same scan-cache / notes dir.
        let pathKey = repoRoot.standardizedFileURL.path
        if isRunning || Self.inFlightPaths.contains(pathKey) {
            // Report contention rather than success. Returning `.success` with
            // the current (often empty) graph made every caller believe it had
            // a real scan: `KnowledgeGraphService` then wrote an all-zero
            // `graph-notes.md`, and the Graph view's spinner never cleared
            // because `$graph` never republished.
            return .failure(.busy)
        }
        isRunning = true
        Self.inFlightPaths.insert(pathKey)
        defer { isRunning = false; Self.inFlightPaths.remove(pathKey) }
        guard FileManager.default.fileExists(atPath: repoRoot.path) else {
            progress = .failed("folder not found")
            return .failure(.folderNotWritable(path: repoRoot.path))
        }
        let launcher = self.launcher
        guard let engine else {
            progress = .failed("no graph engine installed")
            return .failure(.noEngine)
        }

        // Phase 1 — scan. The engine already runs this off the main actor and
        // already excludes markdown from the graph it returns.
        progress = .scanning
        let scanned: CodeScan
        do {
            scanned = try await engine.scanCode(repoRoot: repoRoot)
        } catch {
            progress = .failed(error.localizedDescription)
            return .failure(.engineFailed(error.localizedDescription))
        }
        if Task.isCancelled { progress = .idle; return .failure(.cancelled) }

        // Phase 2 — write the deterministic notes (off the main actor).
        //
        // An engine that reports no symbol scan (a plugin may emit only a
        // graph) writes no notes rather than writing empty ones.
        progress = .buildingGraph
        let result = scanned.scan
        let graph = scanned.graph
        // Write notes and prune orphans ONLY from an authoritative scan.
        //
        // `CodeNoteGenerator.generate`'s tail calls `pruneOrphanNotes` with the
        // scanned paths as its keep-set, so calling it with an empty scan
        // deletes every per-file note under `system/graph/` and empties
        // `index.md` and `graph.json`. That is correct when the repository
        // really has no code files — those notes are stale — and catastrophic
        // when the engine simply does not report symbols, which is what a
        // plugin engine does. `reportsSymbols` separates the two; without it,
        // installing a plugin deleted every note on the next generate.
        if scanned.reportsSymbols {
            let changedPaths = scanned.changedPaths
            await Task.detached(priority: .userInitiated) {
                CodeNoteGenerator.generate(scan: result, repoRoot: repoRoot,
                                           changedPaths: changedPaths)
            }.value
        } else {
            Self.log.info("engine reports no symbol scan — keeping existing notes rather than pruning")
        }
        if Task.isCancelled { progress = .idle; return .failure(.cancelled) }

        // Publish on the main actor.
        self.graph = graph
        progress = .complete(files: result.files.count,
                             edges: graph.edges.count,
                             reused: scanned.reusedFiles)

        // Background enrichment: only when a CLI is configured and files changed.
        // Fire-and-forget — the skeleton above is already the returned result.
        if let cli = cliExecutable, !scanned.changedPaths.isEmpty {
            let changed = scanned.changedPaths
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
