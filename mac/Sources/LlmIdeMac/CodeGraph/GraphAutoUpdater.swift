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
        // Derive doc roots from the SAME root the code graph + memory use, so a
        // graph living in a code/<child> repo isn't merged against the project
        // root's unrelated docs (and the memory artifact lands beside its code).
        let layout = ProjectLayout(root: repoRoot)
        let docRoots = [layout.notesDir, layout.dataDir]
        Task {
            await graph.generate(codeRepoRoot: repoRoot, docRoots: docRoots, memoryRoot: repoRoot)
        }
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
