import XCTest
import GraphCore
import GraphKit
@testable import LlmIdeMacLib

/// Covers the pure, `nonisolated static` half of the knowledge-graph pipeline:
/// doc-set change detection, code+doc merging, and the two memory-artifact
/// renderers. All of it was previously untested despite being the input to
/// everything the agent reads as "repository memory".
final class KnowledgeGraphServiceTests: XCTestCase {

    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("kgs-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ relativePath: String, _ contents: String = "# doc\n") throws {
        let url = root.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    /// `docSetFingerprint` and `merge` moved out of `KnowledgeGraphService` and
    /// into the graph engine, which is where their rules belong: the
    /// fingerprint has to mirror the engine's own document walk, and the merge
    /// resolves doc→code links with the engine's linker.
    private let engine = BuiltinGraphEngine()

    // MARK: - docSetFingerprint

    /// The regression this guards: the fingerprint walked the generator's OWN
    /// output (`graphify-out/`, `system/graph/<path>.md`) and vendor dirs.
    /// Since every regen rewrites those files, the fingerprint changed on every
    /// run and the doc-track cache could never hit.
    func testFingerprintIgnoresGeneratedAndVendorDirs() throws {
        try write("docs/guide.md", "# Guide\n")
        let baseline = engine.docSetFingerprint(roots: [root])

        // Exactly the files a regeneration writes back into the repo.
        try write("graphify-out/memory/repo.md")
        try write("graphify-out/memory/graph-notes.md")
        try write("graphify-out/memory/doc-notes.md")
        try write("system/graph/index.md")
        try write("system/graph/Sources_App_main.swift.md")
        // …plus the vendor noise MemoryGenerator also refuses to ingest.
        try write("node_modules/some-pkg/README.md")
        try write(".build/checkouts/dep/README.md")

        XCTAssertEqual(engine.docSetFingerprint(roots: [root]), baseline,
                       "regen output and vendor docs must not move the doc-set fingerprint")
    }

    func testFingerprintTracksRealDocChanges() throws {
        try write("docs/guide.md", "# Guide\n")
        let baseline = engine.docSetFingerprint(roots: [root])

        try write("docs/guide.md", "# Guide\n\nNow with more content.\n")
        let edited = engine.docSetFingerprint(roots: [root])
        XCTAssertNotEqual(edited, baseline, "editing a real doc must move the fingerprint")

        try write("docs/second.md", "# Second\n")
        XCTAssertNotEqual(engine.docSetFingerprint(roots: [root]), edited,
                          "adding a real doc must move the fingerprint")
    }

    /// A doc buried under a generated dir must not be reachable *through* that
    /// dir — the walk prunes the whole subtree, not just its direct children.
    func testFingerprintPrunesEntireExcludedSubtree() throws {
        try write("docs/guide.md", "# Guide\n")
        let baseline = engine.docSetFingerprint(roots: [root])
        try write("system/graph/nested/deeper/note.md", "# Deep\n")
        XCTAssertEqual(engine.docSetFingerprint(roots: [root]), baseline)
    }

    func testFingerprintIsStableAcrossRepeatedCalls() throws {
        try write("docs/a.md")
        try write("docs/b.md")
        let first = engine.docSetFingerprint(roots: [root])
        XCTAssertEqual(engine.docSetFingerprint(roots: [root]), first)
    }

    // MARK: - merge

    private func chunk(id: String, title: String, body: String,
                       wikiLinks: [String] = [], kind: CGNodeKind = .memoryChunk,
                       graphOnly: Bool = false, relatedModules: [String] = []) -> MemoryChunk {
        MemoryChunk(id: id, docURL: root.appendingPathComponent("\(title).md"),
                    docTitle: title, headingPath: [title], body: body,
                    kind: kind, tags: [], wikiLinks: wikiLinks,
                    graphOnly: graphOnly, relatedModules: relatedModules)
    }

    private func codeGraph() -> CGData {
        CGData(nodes: [
            CGNode(id: "file:kb/db.mjs", title: "db.mjs", kind: .file,
                   metadata: ["source_file": "kb/db.mjs"]),
            CGNode(id: "function:kb/db.mjs:backupTo", title: "backupTo", kind: .function,
                   metadata: ["source_file": "kb/db.mjs"]),
        ], edges: [
            CGEdge(fromId: "file:kb/db.mjs", toId: "function:kb/db.mjs:backupTo", kind: .contains),
        ])
    }

    func testMergeLinksBacktickMentionsToCodeNodes() async throws {
        let c = chunk(id: "chunk1", title: "Storage", body: "Backups run through `backupTo`.")
        let merged = try await engine.merge(code: codeGraph(),
                                            doc: CGData(nodes: [], edges: []),
                                            chunks: [c])
        XCTAssertTrue(merged.edges.contains {
            $0.fromId == "chunk1" && $0.toId == "function:kb/db.mjs:backupTo" && $0.kind == .references
        }, "a backtick mention of a known symbol must produce a doc→code reference edge")
    }

    func testMergeLinksPathMentionsAndWikilinks() async throws {
        let mention = chunk(id: "c1", title: "Ops", body: "See `kb/db.mjs` for details.")
        let wiki = chunk(id: "c2", title: "Design", body: "text", wikiLinks: ["backupTo"])
        let merged = try await engine.merge(code: codeGraph(),
                                            doc: CGData(nodes: [], edges: []),
                                            chunks: [mention, wiki])
        XCTAssertTrue(merged.edges.contains { $0.fromId == "c1" && $0.toId == "file:kb/db.mjs" })
        XCTAssertTrue(merged.edges.contains { $0.fromId == "c2" && $0.toId == "function:kb/db.mjs:backupTo" })
    }

    /// Generic prose must not manufacture edges — only explicitly marked
    /// mentions (backticks) and wikilinks count.
    func testMergeIgnoresUnmarkedProse() async throws {
        let c = chunk(id: "c1", title: "Prose", body: "The backupTo routine runs nightly.")
        let merged = try await engine.merge(code: codeGraph(),
                                            doc: CGData(nodes: [], edges: []),
                                            chunks: [c])
        XCTAssertFalse(merged.edges.contains { $0.fromId == "c1" })
    }

    func testMergeDeduplicatesCrossLinks() async throws {
        // Same symbol reached by BOTH a wikilink and a backtick mention.
        let c = chunk(id: "c1", title: "Both", body: "Call `backupTo` now.", wikiLinks: ["backupTo"])
        let merged = try await engine.merge(code: codeGraph(),
                                            doc: CGData(nodes: [], edges: []),
                                            chunks: [c])
        let hits = merged.edges.filter { $0.fromId == "c1" && $0.toId == "function:kb/db.mjs:backupTo" }
        XCTAssertEqual(hits.count, 1)
    }

    func testMergeUnionsNodesWithoutDuplicating() async throws {
        let doc = CGData(nodes: [CGNode(id: "doc:one", title: "One", kind: .memoryDoc)], edges: [])
        let merged = try await engine.merge(code: codeGraph(), doc: doc, chunks: [])
        XCTAssertEqual(merged.nodes.count, 3)
        XCTAssertEqual(Set(merged.nodes.map(\.id)).count, 3)
    }

    // MARK: - renderGraphNotes / renderDocNotes

    func testGraphNotesRanksDependencyHubs() {
        let code = CGData(nodes: [
            CGNode(id: "file:a.mjs", title: "a.mjs", kind: .file),
            CGNode(id: "file:b.mjs", title: "b.mjs", kind: .file),
            CGNode(id: "file:hub.mjs", title: "hub.mjs", kind: .file),
        ], edges: [
            CGEdge(fromId: "file:a.mjs", toId: "file:hub.mjs", kind: .imports),
            CGEdge(fromId: "file:b.mjs", toId: "file:hub.mjs", kind: .imports),
        ])
        let out = KnowledgeGraphService.renderGraphNotes(code: code, doc: .empty,
                                                         merged: code, chunks: [])
        XCTAssertTrue(out.contains("## Dependency hubs"))
        XCTAssertTrue(out.contains("hub.mjs — imported by 2"))
    }

    /// `graph-only: true` and meeting-style chunks stay in the interactive
    /// graph but must never reach the agent's memory artifact.
    func testMemoryArtifactsExcludeGraphOnlyAndMeetingChunks() {
        let keep = chunk(id: "keep", title: "Architecture", body: "durable")
        let optOut = chunk(id: "skip1", title: "Scratch", body: "x", graphOnly: true)
        let meeting = chunk(id: "skip2", title: "Standup", body: "x", kind: .noteEvent)
        let chunks = [keep, optOut, meeting]

        let docNotes = KnowledgeGraphService.renderDocNotes(docCount: 3, chunks: chunks)
        XCTAssertTrue(docNotes.contains("Architecture"))
        XCTAssertFalse(docNotes.contains("Scratch"))
        XCTAssertFalse(docNotes.contains("Standup"))
        XCTAssertTrue(docNotes.contains("1 section"))

        // Same exclusion contract for the cross-link listing in graph-notes.
        let doc = CGData(nodes: chunks.map {
            CGNode(id: $0.id, title: $0.docTitle, kind: .memoryChunk)
        }, edges: [])
        let merged = CGData(nodes: doc.nodes + codeGraph().nodes, edges: [
            CGEdge(fromId: "skip1", toId: "file:kb/db.mjs", kind: .references, confidence: .inferred),
            CGEdge(fromId: "keep", toId: "file:kb/db.mjs", kind: .references, confidence: .inferred),
        ])
        let graphNotes = KnowledgeGraphService.renderGraphNotes(code: codeGraph(), doc: doc,
                                                                merged: merged, chunks: chunks)
        XCTAssertTrue(graphNotes.contains("Architecture → db.mjs"))
        XCTAssertFalse(graphNotes.contains("Scratch"))
    }

    /// Both lists in graph-notes.md are capped. A cap with no marker reads as a
    /// complete list, so the agent could conclude a real link doesn't exist.
    func testGraphNotesMarksTruncatedLists() {
        let hubCount = 15
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        for i in 0..<hubCount {
            nodes.append(CGNode(id: "file:hub\(i).mjs", title: "hub\(i).mjs", kind: .file))
            nodes.append(CGNode(id: "file:src\(i).mjs", title: "src\(i).mjs", kind: .file))
            edges.append(CGEdge(fromId: "file:src\(i).mjs", toId: "file:hub\(i).mjs", kind: .imports))
        }
        let code = CGData(nodes: nodes, edges: edges)
        let out = KnowledgeGraphService.renderGraphNotes(code: code, doc: .empty,
                                                         merged: code, chunks: [])
        XCTAssertTrue(out.contains("top 10 of \(hubCount) imported modules"), out)

        // Cross-links: 60 doc→code references, rendered 50 at a time.
        let linkCount = 60
        var docNodes: [CGNode] = []
        var crossEdges: [CGEdge] = []
        for i in 0..<linkCount {
            docNodes.append(CGNode(id: "chunk\(i)", title: "Doc \(i)", kind: .memoryChunk))
            crossEdges.append(CGEdge(fromId: "chunk\(i)", toId: "file:kb/db.mjs",
                                     kind: .references, confidence: .inferred))
        }
        let doc = CGData(nodes: docNodes, edges: [])
        let merged = CGData(nodes: codeGraph().nodes + docNodes, edges: crossEdges)
        let linked = KnowledgeGraphService.renderGraphNotes(code: codeGraph(), doc: doc,
                                                            merged: merged, chunks: [])
        XCTAssertTrue(linked.contains("…and \(linkCount - 50) more (list truncated)"), linked)
    }

    func testDocNotesRendersDeclaredModuleAffinity() {
        let c = chunk(id: "c1", title: "Capture", body: "x", relatedModules: ["src/content"])
        let out = KnowledgeGraphService.renderDocNotes(docCount: 1, chunks: [c])
        XCTAssertTrue(out.contains("## Doc ↔ module affinity"))
        XCTAssertTrue(out.contains("Capture → src/content"))
    }

    // MARK: - writeMemoryArtifact

    private var memDir: URL { ProjectLayout(root: root).memoryDir }

    private func generateArtifacts() {
        KnowledgeGraphService.writeMemoryArtifact(to: root, code: codeGraph(), doc: .empty,
                                                  merged: codeGraph(), docCount: 0, chunks: [])
    }

    func testWriteMemoryArtifactWritesIntoTheSystemContainer() throws {
        generateArtifacts()
        for name in ["graph-notes.md", "doc-notes.md"] {
            XCTAssertTrue(FileManager.default.fileExists(
                atPath: memDir.appendingPathComponent(name).path), "missing \(name)")
        }
        // Generated files inside the user's own repo must not flood their git status.
        XCTAssertEqual(try String(contentsOf: memDir.appendingPathComponent(".gitignore"),
                                  encoding: .utf8), "*\n")
    }

    /// The overview is `system/graph/index.md` and nothing copies it. A second
    /// `repo.md` holding the same bytes is exactly what this consolidation removed.
    func testNoDuplicateRepoOverviewIsWritten() throws {
        try write("system/graph/index.md", "# Codebase Index\n\nranked stuff\n")
        generateArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: memDir.appendingPathComponent("repo.md").path))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("graphify-out/memory/repo.md").path))
        // The counts the old fallback body carried live in graph-notes.md.
        let notes = try String(contentsOf: memDir.appendingPathComponent("graph-notes.md"),
                               encoding: .utf8)
        XCTAssertTrue(notes.contains("Code nodes: 2"), notes)
    }

    /// Nothing is written into the `/graphify` skill's tree any more.
    func testNothingIsWrittenIntoTheGraphifyOutTree() {
        generateArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("graphify-out").path))
    }

    // MARK: - idempotent writes

    /// An unchanged regeneration must leave mtimes alone: the extension renders
    /// "updated N minutes ago" from them, so rewriting identical bytes would
    /// report a stale graph as fresh (and churn the file watcher).
    func testUnchangedRegenerationDoesNotTouchFiles() throws {
        generateArtifacts()
        let notes = memDir.appendingPathComponent("graph-notes.md")
        let before = try FileManager.default.attributesOfItem(atPath: notes.path)[.modificationDate] as? Date
        let backdated = Date(timeIntervalSinceNow: -3600)
        try FileManager.default.setAttributes([.modificationDate: backdated], ofItemAtPath: notes.path)

        generateArtifacts()   // identical inputs

        let after = try FileManager.default.attributesOfItem(atPath: notes.path)[.modificationDate] as? Date
        XCTAssertEqual(after?.timeIntervalSince1970 ?? 0, backdated.timeIntervalSince1970, accuracy: 1,
                       "an unchanged artifact must not be rewritten")
        XCTAssertNotNil(before)
    }

    func testChangedContentIsWritten() throws {
        let url = root.appendingPathComponent("idempotent.md")
        XCTAssertTrue(try KnowledgeGraphService.writeIfChanged("first", to: url))
        XCTAssertFalse(try KnowledgeGraphService.writeIfChanged("first", to: url))
        XCTAssertTrue(try KnowledgeGraphService.writeIfChanged("second", to: url))
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "second")
    }

    // MARK: - legacy migration

    func testLegacyChatMemoryIsCarriedForwardAndTheOldTreeRemoved() throws {
        try write("graphify-out/memory/chat-memory.md", "# Chat memory\n- Uses pnpm\n")
        try write("graphify-out/memory/repo.md", "stale copy")
        try write("graphify-out/memory/graph-notes.md", "stale notes")

        generateArtifacts()

        let carried = try String(contentsOf: memDir.appendingPathComponent("chat-memory.md"),
                                 encoding: .utf8)
        XCTAssertTrue(carried.contains("Uses pnpm"), "curated facts must survive the move")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("graphify-out/memory").path),
            "the emptied legacy dir is removed")
    }

    /// A newer canonical file must never be clobbered by a stale legacy one.
    func testExistingCanonicalChatMemoryWinsOverLegacy() throws {
        try write("system/memory/chat-memory.md", "# Chat memory\n- NEW\n")
        try write("graphify-out/memory/chat-memory.md", "# Chat memory\n- OLD\n")

        generateArtifacts()

        let kept = try String(contentsOf: memDir.appendingPathComponent("chat-memory.md"),
                              encoding: .utf8)
        XCTAssertTrue(kept.contains("NEW"))
        XCTAssertFalse(kept.contains("OLD"))
    }

    /// `graphify-out/` belongs to the `/graphify` skill — only OUR files leave.
    func testMigrationLeavesForeignGraphifyArtifactsAlone() throws {
        try write("graphify-out/graph.json", "{}")
        try write("graphify-out/memory/chat-memory.md", "- fact\n")
        try write("graphify-out/memory/skill-owned.json", "{}")

        generateArtifacts()

        XCTAssertTrue(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("graphify-out/graph.json").path))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: root.appendingPathComponent("graphify-out/memory/skill-owned.json").path),
            "a non-ours file keeps the legacy dir alive rather than being deleted")
    }
}
