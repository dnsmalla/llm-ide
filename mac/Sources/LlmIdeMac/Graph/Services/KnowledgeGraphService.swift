import Foundation
import GraphCore
import CryptoKit
import os

/// Stage 1 of the unified knowledge graph:
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
    /// Code + doc unified into one graph, with doc→code cross-links (Stage 2).
    @Published private(set) var mergedGraph: CGData = .empty
    /// Doc-track chunks behind `docGraph`/`mergedGraph` — exposed so the
    /// `GraphAutoUpdater` can hand them to the Code Graph view's session store
    /// (the view needs them to render doc/chunk detail in `.data`/`.all` modes).
    @Published private(set) var docChunks: [MemoryChunk] = []
    /// Number of source docs ingested for the doc track (matches the view's
    /// `memoryDocCount`, sourced from `MemoryGenerator`).
    @Published private(set) var docCount: Int = 0
    /// Stat-fingerprint of the doc set behind the current `docGraph` — published
    /// so the auto-updater can hand it to the session store, letting the view's
    /// manual InfiniteBrain re-generate be skipped when docs are unchanged.
    @Published private(set) var docFingerprint: String?

    private let codeNotes: CodeNoteService
    /// Produces the doc track and performs the join. Injected so this
    /// orchestrator never names a producer type — see `GraphEngine`.
    private let engine: GraphEngine?
    /// Re-entrancy guard — the auto-updater (Stage 5) and a manual run must not
    /// overlap. `CodeNoteService` has its own guard too; this covers the doc
    /// track and the orchestration as a whole.
    private var isRunning = false
    /// Latest request received while a run was in flight — replayed once on
    /// completion so a project switch mid-run isn't dropped (coalescing).
    private var pending: (code: URL?, docs: [URL], memory: URL?)?

    // Stage 3 — doc-track change detection. The doc graph is recomputed only
    // when the doc set's fingerprint changes; otherwise the cached result is
    // reused. (The code track is incremental per-file via CodeNoteService's
    // own scan-cache.) Per-instance/in-session; the Stage 5 auto-updater holds
    // a long-lived instance, so a periodic refresh that finds no doc change is
    // near-free. Reset on project switch.
    private var lastDocFingerprint: String?
    private var cachedDocGraph: CGData = .empty
    private var cachedChunks: [MemoryChunk] = []
    private var cachedDocCount: Int = 0

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp",
                                                category: "KnowledgeGraphService")

    // No default-arg `CodeNoteService()` — a default argument is evaluated in a
    // nonisolated context, but CodeNoteService's init is @MainActor-isolated.
    // Construct it inside this @MainActor init instead.
    init(engine: GraphEngine? = GraphEngines.resolveDefault()) {
        self.engine = engine
        self.codeNotes = CodeNoteService(engine: engine)
    }

    /// Run both tracks for a project.
    /// - Parameters:
    ///   - codeRepoRoot: the git repo to scan for code (nil skips the code track).
    ///   - docRoots: folders whose docs feed InfiniteBrain (typically the
    ///     project's `llm-doc/` and `data/` dirs). Missing folders are skipped.
    ///   - memoryRoot: when set, write the agent-facing memory artifacts under
    ///     `<memoryRoot>/system/memory/` (the path the extension reads — see
    ///     `graphkit/paths.mjs`). Pass the repo the user has indexed in the
    ///     extension.
    func generate(codeRepoRoot: URL?, docRoots: [URL], memoryRoot: URL? = nil) async {
        // Coalesce: if a run is in flight, stash the latest request and replay
        // it once when the current run finishes — so a project switch (or any
        // newer request) mid-run isn't silently dropped until the next tick.
        if isRunning {
            pending = (codeRepoRoot, docRoots, memoryRoot)
            return
        }
        isRunning = true
        await runOnce(codeRepoRoot: codeRepoRoot, docRoots: docRoots, memoryRoot: memoryRoot)
        isRunning = false
        if let p = pending {
            pending = nil
            await generate(codeRepoRoot: p.code, docRoots: p.docs, memoryRoot: p.memory)
        }
    }

    private func runOnce(codeRepoRoot: URL?, docRoots: [URL], memoryRoot: URL?) async {
        phase = .running

        // Code track — StructureScanner filters to code extensions internally
        // and is incremental (scan-cache), so this is cheap on re-runs.
        if let codeRepoRoot {
            // The result MUST be inspected. Discarding it (`_ = await …`) meant
            // a run that returned early — the scan lock was held by the
            // background auto-updater, or a plugin engine exited non-zero —
            // published an empty graph that fell straight through to the
            // artifact write below, rewriting `graph-notes.md` as
            // "Code nodes: 0" with no dependency hubs. Exactly the regression
            // the doc track was already hardened against.
            switch await codeNotes.generate(repoRoot: codeRepoRoot) {
            case .success:
                // "md is doc": the scanner emits markdown as code `.docPage`
                // nodes; strip them so markdown lives only in the doc track and
                // is not double-counted when merged below.
                codeGraph = FileClassifier.strippingDocNodes(from: codeNotes.graph)
            case .failure(.busy):
                // Expected, not a failure: the background updater and a manual
                // generate both run on timers and contend for the same repo's
                // scan lock. Keep whatever code graph this instance already
                // holds and carry on with the doc track — abandoning the whole
                // refresh over routine contention traded a data bug for a UX
                // one.
                Self.log.info("code track busy — reusing the retained code graph")
            case .failure(let error):
                Self.log.error("code track unavailable: \(error.localizedDescription, privacy: .public)")
                phase = .failed(error.localizedDescription)
                return
            }
        }

        // Doc track — MemoryGenerator walks each root (bounded) and filters to
        // doc extensions. Pure text chunking (no LLM), run off the main actor.
        let roots = docRoots
        // Recompute the doc graph only when the doc set changed (stat-only
        // fingerprint); otherwise reuse the cached result.
        let fingerprint = await Task.detached(priority: .utility) { [engine] in
            engine?.docSetFingerprint(roots: roots) ?? ""
        }.value
        docFingerprint = fingerprint
        let doc: (graph: CGData, chunks: [MemoryChunk], docCount: Int)
        if let last = lastDocFingerprint, last == fingerprint {
            doc = (cachedDocGraph, cachedChunks, cachedDocCount)
        } else if let engine {
            do {
                let generated = try await engine.generateDocMemory(roots: roots)
                doc = (generated.graph, generated.chunks, generated.docCount)
                // Cache ONLY a non-empty result. Caching an empty one under the
                // fresh fingerprint pinned it for the rest of the session:
                // every later run saw a fingerprint hit and never retried. An
                // engine can return empty without throwing, so checking for a
                // thrown error was not enough.
                if !doc.graph.nodes.isEmpty {
                    lastDocFingerprint = fingerprint
                    cachedDocGraph = doc.graph
                    cachedChunks = doc.chunks
                    cachedDocCount = doc.docCount
                }
            } catch {
                Self.log.error("doc track failed: \(error.localizedDescription, privacy: .public)")
                phase = .failed(error.localizedDescription)
                return
            }
        } else {
            phase = .failed("no graph engine installed")
            return
        }
        docGraph = doc.graph
        docChunks = doc.chunks
        docCount = doc.docCount

        // Stage 2 — unify code + doc into one graph, with doc→code cross-links.
        guard let engine else {
            phase = .failed("no graph engine installed")
            return
        }
        do {
            mergedGraph = try await engine.merge(code: codeGraph, doc: doc.graph,
                                                 chunks: doc.chunks)
        } catch {
            Self.log.error("merge failed: \(error.localizedDescription, privacy: .public)")
            phase = .failed(error.localizedDescription)
            return
        }

        // Stage 4 — write the agent-facing memory artifacts where the extension
        // reads them (system/memory/).
        //
        // Guarded on a non-empty merged graph, mirroring
        // `CodeGraphUploadService`'s refusal to upload an empty one. Returning
        // early on *thrown* failures was not enough: both tracks can succeed
        // while producing nothing — a Go or Rust repository yields no code
        // files at all (the scanner handles ts/js/swift/kt/py/md only) and no
        // docs, and a plugin can exit 0 with `{"nodes":[],"edges":[]}`. Either
        // way the write would replace `graph-notes.md` with
        // "Code nodes: 0 / Doc nodes: 0 / Edges: 0".
        if mergedGraph.nodes.isEmpty {
            Self.log.info("merged graph is empty — leaving existing memory artifacts alone")
            phase = .complete(codeNodes: codeGraph.nodes.count,
                              docNodes: docGraph.nodes.count)
            return
        }
        if let memoryRoot {
            let code = codeGraph, docData = docGraph, mg = mergedGraph
            let chunks = doc.chunks, dCount = doc.docCount
            await Task.detached(priority: .utility) {
                Self.writeMemoryArtifact(to: memoryRoot, code: code, doc: docData, merged: mg,
                                         docCount: dCount, chunks: chunks)
            }.value
        }

        Self.log.info("knowledge graph: code=\(self.codeGraph.nodes.count, privacy: .public) doc=\(self.docGraph.nodes.count, privacy: .public) merged=\(self.mergedGraph.nodes.count, privacy: .public) nodes / \(self.mergedGraph.edges.count, privacy: .public) edges")
        phase = .complete(codeNodes: codeGraph.nodes.count, docNodes: docGraph.nodes.count)
    }

    /// Stage 4 — render the merged graph to the memory artifacts the extension
    /// agent reads, in `<root>/system/memory/`: `graph-notes.md` (cross-links +
    /// dependency hubs) and `doc-notes.md` (doc sections + module affinity).
    /// Writing these is what makes the agent's "Repository memory" block
    /// non-empty.
    ///
    /// Two things this deliberately does NOT do:
    ///
    ///  • It does not write a `repo.md`. That file used to be a byte-for-byte
    ///    COPY of the code graph's `system/graph/index.md`, rewritten every
    ///    generation — a second file with the same content that could only
    ///    drift. The reader now reads `index.md`, the one file that owns it.
    ///    (The old no-index fallback body carried node counts; `graph-notes.md`
    ///    already carries the same counts, so nothing is lost.)
    ///  • It does not write into `graphify-out/`. That tree belongs to the
    ///    separate `/graphify` skill; `migrateLegacyMemoryDir` moves any
    ///    leftovers out of it once.
    ///
    /// Writes are idempotent: a file whose content is unchanged is left
    /// untouched, so mtimes only move on a real change (the extension surfaces
    /// "updated N minutes ago" from them) and unchanged regenerations don't
    /// churn the watcher or the disk.
    nonisolated static func writeMemoryArtifact(to repoRoot: URL, code: CGData, doc: CGData, merged: CGData,
                                                docCount: Int, chunks: [MemoryChunk]) {
        let memDir = ProjectLayout(root: repoRoot).memoryDir
        do {
            try FileManager.default.createDirectory(at: memDir, withIntermediateDirectories: true)
        } catch {
            log.error("memory artifact: mkdir failed at \(memDir.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return
        }
        migrateLegacyMemoryDir(repoRoot: repoRoot, into: memDir)
        // Self-ignoring marker, same as system/graph: these are generated files
        // inside the USER's repo, whose .gitignore we don't control, so without
        // this they'd flood their Source Control view. (`system/faults` and
        // `system/q&a` are deliberately NOT covered — those are meant to be
        // committed, which is why the marker sits here and not on `system/`.)
        try? "*\n".write(to: memDir.appendingPathComponent(".gitignore"),
                         atomically: true, encoding: .utf8)
        do {
            try writeIfChanged(MemoryArtifactRenderer.renderGraphNotes(code: code, doc: doc, merged: merged, chunks: chunks),
                               to: memDir.appendingPathComponent("graph-notes.md"))
            try writeIfChanged(MemoryArtifactRenderer.renderDocNotes(docCount: docCount, chunks: chunks),
                               to: memDir.appendingPathComponent("doc-notes.md"))
        } catch {
            // Don't fail silently — a write error means the agent keeps reading
            // stale/empty memory with no signal otherwise.
            log.error("memory artifact: write failed at \(memDir.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Write `body` only when it differs from what's on disk. Returns true when
    /// the file was actually written.
    @discardableResult
    nonisolated static func writeIfChanged(_ body: String, to url: URL) throws -> Bool {
        if let existing = try? String(contentsOf: url, encoding: .utf8), existing == body { return false }
        try body.write(to: url, atomically: true, encoding: .utf8)
        return true
    }

    /// One-time move of pre-consolidation artifacts out of the `/graphify`
    /// skill's tree and into `system/memory/`.
    ///
    /// Only `chat-memory.md` is carried over — it holds LLM-curated facts that
    /// cannot be regenerated, and only when the destination doesn't already have
    /// one (a newer file must never be clobbered by a stale one). The other
    /// files are regenerated from the graph on this very run, and `repo.md` no
    /// longer exists at all, so they're simply deleted. The legacy directory is
    /// then removed if empty, leaving `graphify-out/` to its actual owner.
    nonisolated static func migrateLegacyMemoryDir(repoRoot: URL, into memDir: URL) {
        let fm = FileManager.default
        let legacy = repoRoot.appendingPathComponent("graphify-out", isDirectory: true)
            .appendingPathComponent("memory", isDirectory: true)
        guard fm.fileExists(atPath: legacy.path) else { return }

        let carried = "chat-memory.md"
        let src = legacy.appendingPathComponent(carried)
        let dst = memDir.appendingPathComponent(carried)
        if fm.fileExists(atPath: src.path) && !fm.fileExists(atPath: dst.path) {
            do { try fm.moveItem(at: src, to: dst) }
            catch { log.error("memory migration: could not carry \(carried, privacy: .public) forward: \(error.localizedDescription, privacy: .public)") }
        }
        for name in ["repo.md", "graph-notes.md", "doc-notes.md", carried] {
            try? fm.removeItem(at: legacy.appendingPathComponent(name))
        }
        // Only removes the directory when nothing else is in it — a `/graphify`
        // artifact that happens to live under memory/ is not ours to delete.
        if let rest = try? fm.contentsOfDirectory(atPath: legacy.path), rest.isEmpty {
            try? fm.removeItem(at: legacy)
        }
        log.info("migrated legacy memory dir for \(repoRoot.lastPathComponent, privacy: .public)")
    }

    /// Clear the doc-track cache — call on project switch so a new project
    /// doesn't reuse the previous project's doc graph.
    func resetCache() {
        lastDocFingerprint = nil
        cachedDocGraph = .empty
        cachedChunks = []
        cachedDocCount = 0
        docFingerprint = nil
    }

}
