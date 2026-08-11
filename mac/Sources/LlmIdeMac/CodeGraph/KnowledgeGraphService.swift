import Foundation
import GraphKit
import CryptoKit
import os

/// Stage 1 of the unified knowledge graph
/// (docs/superpowers/plans/2026-06-22-unified-knowledge-graph-automation.md):
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
    init() {
        self.codeNotes = CodeNoteService()
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
            _ = await codeNotes.generate(repoRoot: codeRepoRoot)
            // "md is doc": the scanner emits markdown as code `.docPage` nodes;
            // strip them so markdown lives only in the doc track and isn't
            // double-counted when merged below.
            codeGraph = FileClassifier.strippingDocNodes(from: codeNotes.graph)
        }

        // Doc track — MemoryGenerator walks each root (bounded) and filters to
        // doc extensions. Pure text chunking (no LLM), run off the main actor.
        let roots = docRoots
        // Recompute the doc graph only when the doc set changed (stat-only
        // fingerprint); otherwise reuse the cached result.
        let fingerprint = await Task.detached(priority: .utility) { Self.docSetFingerprint(roots: roots) }.value
        docFingerprint = fingerprint
        let doc: (graph: CGData, chunks: [MemoryChunk], docCount: Int)
        if let last = lastDocFingerprint, last == fingerprint {
            doc = (cachedDocGraph, cachedChunks, cachedDocCount)
        } else {
            doc = await Task.detached(priority: .userInitiated) { () -> (graph: CGData, chunks: [MemoryChunk], docCount: Int) in
                var nodes: [CGNode] = []
                var edges: [CGEdge] = []
                var chunks: [MemoryChunk] = []
                var docCount = 0
                var seenNode = Set<String>()
                let fm = FileManager.default
                for root in roots {
                    var isDir: ObjCBool = false
                    guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else { continue }
                    let mem = MemoryGenerator.generate(from: root)
                    for n in mem.graph.nodes where seenNode.insert(n.id).inserted { nodes.append(n) }
                    // CGEdge has no id; doc graphs from distinct roots have disjoint
                    // (path-hashed) node ids, so their edges can't collide — append.
                    edges.append(contentsOf: mem.graph.edges)
                    chunks.append(contentsOf: mem.chunks)
                    docCount += mem.docCount
                }
                return (CGData(nodes: nodes, edges: edges), chunks, docCount)
            }.value
            lastDocFingerprint = fingerprint
            cachedDocGraph = doc.graph
            cachedChunks = doc.chunks
            cachedDocCount = doc.docCount
        }
        docGraph = doc.graph
        docChunks = doc.chunks
        docCount = doc.docCount

        // Stage 2 — unify code + doc into one graph, with doc→code cross-links.
        mergedGraph = Self.merge(code: codeGraph, doc: doc.graph, chunks: doc.chunks)

        // Stage 4 — write the agent-facing memory artifacts where the extension
        // reads them (system/memory/), fixing the previously-empty memory.
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
            try writeIfChanged(renderGraphNotes(code: code, doc: doc, merged: merged, chunks: chunks),
                               to: memDir.appendingPathComponent("graph-notes.md"))
            try writeIfChanged(renderDocNotes(docCount: docCount, chunks: chunks),
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

    /// Render `graph-notes.md`: counts plus the doc→code cross-links (the
    /// cross-domain edges Stage 2 adds), which are the most useful thing the
    /// agent can't get from the code or docs alone. Routing: like
    /// `renderDocNotes`, chunks marked `graph-only: true` or classified
    /// `.noteEvent` are excluded here too — `graph-notes.md` lives in the
    /// same agent-facing memory artifact directory as `doc-notes.md`, so the
    /// same exclusion contract must hold for both files, not just one of
    /// them. (The interactive GRAPH itself, via `merge()`, still contains
    /// these edges — only the memory-artifact rendering excludes them.)
    nonisolated static func renderGraphNotes(code: CGData, doc: CGData, merged: CGData,
                                             chunks: [MemoryChunk]) -> String {
        // Chunk graph-node ids equal MemoryChunk.id (see merge()'s doc
        // comment) — exclude graph-only/meeting chunk ids from both the doc
        // title lookup and the cross-link rendering below.
        let excludedIds = Set(chunks.filter { $0.graphOnly || $0.kind == .noteEvent }.map(\.id))
        var out = "# Graph notes\n\n"
        out += "- Code nodes: \(code.nodes.count)\n- Doc nodes: \(doc.nodes.count)\n- Edges: \(merged.edges.count)\n\n"
        let codeIds = Set(code.nodes.map(\.id))
        let docTitle = Dictionary(doc.nodes.filter { !excludedIds.contains($0.id) }.map { ($0.id, $0.title) },
                                  uniquingKeysWith: { a, _ in a })
        let codeTitle = Dictionary(code.nodes.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
        let crossLinks = merged.edges.filter {
            $0.kind == .references && docTitle[$0.fromId] != nil && codeIds.contains($0.toId)
        }
        if !crossLinks.isEmpty {
            let shown = 50
            out += "## Doc → code references\n"
            for e in crossLinks.prefix(shown) {
                out += "- \(docTitle[e.fromId] ?? e.fromId) → \(codeTitle[e.toId] ?? e.toId)\n"
            }
            // Say so when the list is cut off. Without this the agent reads a
            // truncated list as the complete set of doc→code links and can
            // conclude a real reference doesn't exist.
            if crossLinks.count > shown {
                out += "- …and \(crossLinks.count - shown) more (list truncated)\n"
            }
            out += "\n"
        }

        // Dependency hubs: the most-imported code nodes. The import graph is
        // the one thing the graph knows that neither repo.md prose nor doc
        // notes carry — surfacing the top of it lets the agent see cross-module
        // structure without a graph query.
        var inDegree: [String: Int] = [:]
        for e in code.edges where e.kind == .imports {
            inDegree[e.toId, default: 0] += 1
        }
        let ranked = inDegree.sorted { ($0.value, $1.key) > ($1.value, $0.key) }
        let hubs = ranked.prefix(10)
        if !hubs.isEmpty {
            out += "## Dependency hubs\n"
            for (id, count) in hubs {
                out += "- \(codeTitle[id] ?? id) — imported by \(count)\n"
            }
            // Ranked list — mark it as a top-N so the agent doesn't read the
            // absence of a module here as "nothing imports it".
            if ranked.count > hubs.count {
                out += "- …top \(hubs.count) of \(ranked.count) imported modules\n"
            }
            out += "\n"
        }
        return out
    }

    /// Render `doc-notes.md`: the doc/InfiniteBrain content for the combined
    /// memory the agent reads — docs grouped by title, each listing its chunk
    /// headings. Routing: chunks marked `graph-only: true` (frontmatter — an
    /// explicit, author-controlled opt-out) and meeting-style chunks
    /// (`.noteEvent`) stay in the GRAPH but are excluded from the agent's
    /// memory artifact. Declared `related-modules` affinities get their own
    /// section so the agent knows which docs govern which code.
    ///
    /// `.noteEvent` is NOT author-controlled the way `graph-only` is — it's
    /// graph-kit's automatic per-heading keyword classification
    /// (`classify(heading:body:)`, matching "meeting"/"standup"/"retro" in a
    /// heading), and that heading match overrides even an explicit
    /// frontmatter `type:` for that one chunk. Known limitation: a heading
    /// like "Meeting: Q3 Architecture Review" gets classified `.noteEvent`
    /// and dropped from memory even if its body holds durable architectural
    /// content — authors should avoid "meeting"/"standup"/"retro" in headings
    /// for content meant to stay in agent memory.
    nonisolated static func renderDocNotes(docCount: Int, chunks: [MemoryChunk]) -> String {
        let memoryChunks = chunks.filter { !$0.graphOnly && $0.kind != .noteEvent }
        var out = "# Documentation memory\n\n"
        out += "\(docCount) document\(docCount == 1 ? "" : "s") · "
        out += "\(memoryChunks.count) section\(memoryChunks.count == 1 ? "" : "s").\n\n"
        let byDoc = Dictionary(grouping: memoryChunks, by: \.docTitle)
        for (docTitle, docChunks) in byDoc.sorted(by: { $0.key < $1.key }) {
            out += "## \(docTitle)\n"
            for chunk in docChunks {
                out += "- \(chunk.displayHeading)\n"
            }
            out += "\n"
        }
        // Module affinity: docTitle → declared modules, deduped, sorted.
        var affinities: [(doc: String, module: String)] = []
        var seen = Set<String>()
        for chunk in memoryChunks {
            for m in chunk.relatedModules {
                let key = "\(chunk.docTitle)→\(m)"
                if seen.insert(key).inserted { affinities.append((chunk.docTitle, m)) }
            }
        }
        if !affinities.isEmpty {
            out += "## Doc ↔ module affinity\n"
            for a in affinities.sorted(by: { ($0.doc, $0.module) < ($1.doc, $1.module) }) {
                out += "- \(a.doc) → \(a.module)\n"
            }
            out += "\n"
        }
        return out
    }

    /// Merge the code and doc graphs into one and add doc→code cross-links via
    /// two mechanisms:
    ///   1. Wikilinks — a doc chunk that EXPLICITLY references a code symbol
    ///      via a `[[wikilink]]` gets a `references` edge to that code node.
    ///      A chunk's (heading-derived) title is NOT matched here, because
    ///      generic headings like "Config"/"Setup"/"main" collide with code
    ///      symbol names and would manufacture false edges.
    ///   2. Mentions — inline backtick spans (`` `kb/db.mjs` ``, `` `backupTo` ``)
    ///      resolved against a code-entity inventory (title + source-file path)
    ///      via `DocCodeLinker`. Real-world docs almost never use wikilinks, so
    ///      this is the mechanism that actually produces cross-links in
    ///      practice; wikilinks are kept for the rare doc that does use them.
    /// Node ids are namespaced (code paths/symbols vs `doc:`/chunk hashes) so
    /// the union can't collide; chunk graph-node ids equal `MemoryChunk.id`,
    /// so the cross-link `fromId` resolves to a real node.
    nonisolated static func merge(code: CGData, doc: CGData, chunks: [MemoryChunk]) -> CGData {
        var nodes: [CGNode] = []
        var seen = Set<String>()
        for n in code.nodes + doc.nodes where seen.insert(n.id).inserted { nodes.append(n) }
        var edges = code.edges + doc.edges

        // Index code nodes by lowercased title for name matching.
        var codeIdsByTitle: [String: [String]] = [:]
        for n in code.nodes { codeIdsByTitle[n.title.lowercased(), default: []].append(n.id) }
        guard !codeIdsByTitle.isEmpty else { return CGData(nodes: nodes, edges: edges) }

        var crossSeen = Set<String>()
        for chunk in chunks {
            for name in chunk.wikiLinks.map({ $0.lowercased() }) {
                guard let targets = codeIdsByTitle[name] else { continue }
                for codeId in targets {
                    let key = "\(chunk.id)->\(codeId)"
                    guard crossSeen.insert(key).inserted else { continue }
                    edges.append(CGEdge(fromId: chunk.id, toId: codeId,
                                        kind: .references, confidence: .inferred))
                }
            }
        }

        // Mention links: shape-qualified backtick mentions (`kb/db.mjs`,
        // `backupTo`) resolved against the code inventory — the deterministic
        // replacement for wikilink-only linking (which real docs never use).
        // Inventory keys: node title (symbols, file titles) plus any explicit
        // relative-path metadata, all lowercased. No separate basename key —
        // relies on StructureGraphBuilder always titling .file nodes with the
        // path's basename, so basename mentions already hit codeIdsByTitle.
        var inventory: [String: [String]] = codeIdsByTitle
        for n in code.nodes {
            if let p = n.metadata["source_file"]?.lowercased(), inventory[p] == nil {
                inventory[p, default: []].append(n.id)
            }
        }
        for link in DocCodeLinker.links(chunks: chunks, inventory: inventory) {
            let key = "\(link.chunkID)->\(link.codeNodeID)"
            guard crossSeen.insert(key).inserted else { continue }
            // NOTE: mention links carry a graduated confidence score
            // (link.confidence: 0.9 path-shaped / 0.7 symbol-shaped) that
            // we currently collapse into the same .inferred tier used for
            // 100%-certain wikilinks, losing that distinction downstream.
            // Deliberate deferral: CGEdgeConfidence has no tier that maps
            // cleanly to "heuristically scored, not author-asserted" —
            // revisit if confidence-sensitive consumers need it.
            edges.append(CGEdge(fromId: link.chunkID, toId: link.codeNodeID,
                                kind: .references, confidence: .inferred))
        }
        return CGData(nodes: nodes, edges: edges)
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

    /// Cheap change signal for the doc set: sorted `path|size|mtime` over every
    /// doc-extension file under the roots, hashed. Stat-only (no file reads),
    /// so re-running when nothing changed is near-free; the doc track recomputes
    /// only when a doc is added, removed, or edited.
    ///
    /// The walk MUST mirror `MemoryGenerator.collectDocs` — same extension set,
    /// same size cap, same file cap, and crucially the same `ExcludedDirs`
    /// pruning. Omitting the exclusions made the fingerprint cover files the
    /// generator never ingests, which broke the cache in both directions:
    ///
    ///   • every regen rewrites `graphify-out/memory/*.md` and one
    ///     `system/graph/<path>.md` per code file — all doc-extension files —
    ///     so the fingerprint changed on EVERY run and the cache never hit
    ///     (nor did the view's manual-regenerate skip);
    ///   • those generated notes (plus `node_modules` READMEs) could fill the
    ///     500-entry cap before the walk reached a real doc, so an actual doc
    ///     edit left the fingerprint unchanged and the doc graph went stale.
    nonisolated static func docSetFingerprint(roots: [URL]) -> String {
        // Bound the walk to the same window MemoryGenerator actually ingests
        // (maxFiles 500 / 2 MB per file) so the fingerprint covers exactly the
        // set that affects output — avoids unbounded stat walks and false-
        // positive recomputes from files the generator never reads.
        let maxFiles = 500
        let maxFileBytes = 2_000_000
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        var entries: [String] = []
        outer: for root in roots {
            // Mirror MemoryGenerator.collectDocs options so the fingerprint
            // covers exactly the set the generator ingests (it skips package
            // descendants too — otherwise a doc inside a .bundle would flip the
            // fingerprint without ever changing output).
            guard let en = fm.enumerator(at: root, includingPropertiesForKeys: keys,
                                         options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in en {
                // Same vendor/build/generated-output pruning collectDocs applies.
                // Same vendor/build/generated-output pruning collectDocs applies.
                if let name = url.pathComponents.last, ExcludedDirs.names.contains(name) {
                    en.skipDescendants(); continue
                }
                guard FileClassifier.docExtensions.contains(url.pathExtension.lowercased()) else { continue }
                let vals = try? url.resourceValues(forKeys: Set(keys))
                guard vals?.isRegularFile == true else { continue }
                let size = vals?.fileSize ?? 0
                guard size <= maxFileBytes else { continue }
                let mtime = vals?.contentModificationDate?.timeIntervalSince1970 ?? 0
                entries.append("\(url.path)|\(size)|\(mtime)")
                if entries.count >= maxFiles { break outer }
            }
        }
        entries.sort()
        let digest = SHA256.hash(data: Data(entries.joined(separator: "\n").utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
