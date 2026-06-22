import Foundation
import os

/// Stage 5 of the unified knowledge graph
/// (docs/superpowers/plans/2026-06-22-unified-knowledge-graph-automation.md):
/// drives `KnowledgeGraphService` automatically — on project open/switch and on
/// a periodic timer — so the graph + memory stay current without the manual
/// "Generate" button.
///
/// "Update only on the existing data": the auto-run is GATED to repos that
/// already have a generated graph (`system/graph/index.md`). First-generation
/// stays a manual action; automation only *maintains* what exists. Combined
/// with the incremental code scan-cache and the doc-set fingerprint, a periodic
/// tick that finds no change is near-free.
@MainActor
final class GraphAutoUpdater: ObservableObject {
    /// Exposed so the UI can observe the generated graphs.
    let graph = KnowledgeGraphService()

    /// The Code Graph view's session store. Set once by `AppShell` (both are
    /// app-level objects). After each background run we publish the generated
    /// graphs here so the view shows the auto-maintained graph on its next
    /// appearance instead of recomputing the same scan — closing the previous
    /// "two disjoint graph instances" gap where auto-run results were invisible
    /// to the UI. `weak` because the store is owned by the app's `@StateObject`.
    weak var sessionStore: GraphSessionStore?

    private weak var projectStore: ProjectStore?
    private let intervalSeconds: TimeInterval
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    private var started = false

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp",
                                                category: "GraphAutoUpdater")

    init(projectStore: ProjectStore, intervalMinutes: Int = 15) {
        self.projectStore = projectStore
        self.intervalSeconds = TimeInterval(max(5, intervalMinutes) * 60)
    }

    /// Begin auto-updating: re-run on project open/switch + on the interval.
    /// Idempotent.
    func start() {
        guard !started else { return }
        started = true
        observer = NotificationCenter.default.addObserver(
            forName: .activeProjectChanged, object: nil, queue: .main
        ) { [weak self] _ in
            // The notification block is not @MainActor-typed; hop on.
            Task { @MainActor in
                self?.graph.resetCache()
                self?.runIfEligible()
            }
        }
        scheduleTimer()
        runIfEligible()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        started = false
    }

    private func scheduleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: intervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.runIfEligible() }
        }
    }

    /// Resolve the active project's repo + doc roots and, if a graph already
    /// exists for the repo, run an incremental update. No-op otherwise.
    private func runIfEligible() {
        guard let ap = projectStore?.activeProject else { return }
        let projectRoot = URL(fileURLWithPath: ap.localPath)
        guard let repoRoot = Self.existingGraphRepo(projectRoot: projectRoot) else {
            // No graph generated yet — first generation stays manual.
            return
        }
        // Feed InfiniteBrain the repo itself — the manual "InfiniteBrain" button
        // walks the repo the same way (MemoryGenerator.generate(from: repo)), and
        // a code/<child> repo's docs live *inside* it (e.g. `docs/**/*.md`), not in
        // repo-relative `notes/`+`data/` dirs that don't exist. The previous
        // [repoRoot/notes, repoRoot/data] roots were always-missing, so every auto
        // run recorded "Doc nodes: 0" and the agent memory carried no doc graph.
        // Scanning the repo root keeps the doc set within the same repo the code
        // graph + memory use (so a child repo still isn't merged against the
        // project root's unrelated docs); MemoryGenerator filters to doc
        // extensions and is bounded, and the stat-only fingerprint makes an
        // unchanged re-tick near-free.
        let docRoots = [repoRoot]
        Task { [weak self] in
            guard let self else { return }
            await self.graph.generate(codeRepoRoot: repoRoot, docRoots: docRoots, memoryRoot: repoRoot)
            self.publishToSession(repoRoot: repoRoot)
        }
    }

    /// Mirror the freshly generated graphs into the Code Graph view's session
    /// store, keyed by the same `repo#mode` the view uses. Stored RAW
    /// (`laidOut: false`): `KnowledgeGraphService` produces position-less graphs
    /// and layout is the view's job, so the view lays them out with its own
    /// pipeline on hydrate. No-op until `AppShell` has wired `sessionStore`.
    private func publishToSession(repoRoot: URL) {
        guard let store = sessionStore else { return }
        // Mode raw values mirror UAGraphView.Mode: code / data / all.
        // Carry the doc fingerprint on the doc-bearing modes so the view's
        // manual InfiniteBrain re-generate can reuse this result when the docs
        // are unchanged (preserved across the view's later layout re-cache).
        let fp = graph.docFingerprint
        store.store(repo: repoRoot, mode: "code", graph: graph.codeGraph, laidOut: false)
        store.store(repo: repoRoot, mode: "data", graph: graph.docGraph,
                    chunks: graph.docChunks, docCount: graph.docCount, laidOut: false, docFingerprint: fp)
        store.store(repo: repoRoot, mode: "all", graph: graph.mergedGraph,
                    chunks: graph.docChunks, docCount: graph.docCount, laidOut: false, docFingerprint: fp)
        Self.log.info("published auto-graph to session store: code=\(self.graph.codeGraph.nodes.count, privacy: .public) doc=\(self.graph.docGraph.nodes.count, privacy: .public) all=\(self.graph.mergedGraph.nodes.count, privacy: .public) for \(repoRoot.lastPathComponent, privacy: .public)")
    }

    /// The repo that already has a generated code graph (`system/graph/index.md`):
    /// the project root itself, else the first immediate child of `code/` that
    /// has one. Returns nil when nothing has been generated yet.
    static func existingGraphRepo(projectRoot: URL) -> URL? {
        let fm = FileManager.default
        func hasGraph(_ root: URL) -> Bool {
            fm.fileExists(atPath: ProjectLayout(root: root).graphDir.appendingPathComponent("index.md").path)
        }
        if hasGraph(projectRoot) { return projectRoot }
        let codeDir = ProjectLayout(root: projectRoot).codeDir
        let children = (try? fm.contentsOfDirectory(at: codeDir, includingPropertiesForKeys: [.isDirectoryKey],
                                                    options: [.skipsHiddenFiles])) ?? []
        for child in children {
            let isDir = (try? child.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir, hasGraph(child) { return child }
        }
        return nil
    }
}
