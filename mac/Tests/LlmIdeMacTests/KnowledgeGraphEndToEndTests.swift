import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// Full-pipeline test: builds a REAL git repo on disk, runs the actual
/// generation (StructureScanner → StructureGraphBuilder → CodeNoteGenerator →
/// memory artifacts), and asserts the resulting file tree exactly.
///
/// Every other test in this suite feeds hand-built `CGData` to one function.
/// This one runs the thing end to end, which is the only way to catch a
/// duplicate output file, a directory written in the wrong place, or a
/// regeneration that rewrites files it shouldn't.
@MainActor
final class KnowledgeGraphEndToEndTests: XCTestCase {

    private var repo: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("kg-e2e-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        // On macOS $TMPDIR is /var/... which is a symlink to /private/var/...;
        // FileManager's enumerator yields the resolved form, so resolve up front
        // or repo-relative path stripping silently fails.
        repo = base.resolvingSymlinksInPath()

        try write("src/Database.swift", """
        import Foundation

        /// Stores things.
        final class Database {
            func backupTo(path: String) -> Bool { true }
            func restore() {}
        }
        """)
        try write("src/App.swift", """
        import Foundation

        struct App {
            let db = Database()
            func run() { _ = db.backupTo(path: "/tmp/x") }
        }
        """)
        try write("docs/architecture.md", """
        ---
        tags: [design]
        related-modules: [src/Database.swift]
        ---
        # Architecture

        The `Database` type owns persistence. Call `backupTo` before a migration.
        See `src/Database.swift` for details.
        """)
        try write("README.md", "# Demo repo\n\nA fixture.\n")

        // A real git repo: StructureScanner prefers `git ls-files`.
        try runGit(["init", "-q"])
        try runGit(["config", "user.email", "t@example.com"])
        try runGit(["config", "user.name", "T"])
        try runGit(["add", "-A"])
        try runGit(["commit", "-qm", "fixture"])
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: repo)
    }

    private func write(_ rel: String, _ body: String) throws {
        let url = repo.appendingPathComponent(rel)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try body.write(to: url, atomically: true, encoding: .utf8)
    }

    @discardableResult
    private func runGit(_ args: [String]) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", repo.path] + args
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Every file under the repo that the generator produced, repo-relative,
    /// excluding the fixture sources and git's own storage.
    private func generatedTree() throws -> [String] {
        // `enumerator(atPath:)` yields paths already relative to the root, which
        // avoids stripping a prefix by hand — on macOS $TMPDIR involves the
        // /var → /private/var symlink and the two forms don't string-match.
        guard let en = fm.enumerator(atPath: repo.path) else { return [] }
        let fixtures: Set<String> = ["src/Database.swift", "src/App.swift",
                                     "docs/architecture.md", "README.md"]
        var out: [String] = []
        for case let rel as String in en {
            if rel.hasPrefix(".git/") || rel == ".git" { continue }
            if fixtures.contains(rel) { continue }
            var isDir: ObjCBool = false
            let full = repo.appendingPathComponent(rel).path
            guard fm.fileExists(atPath: full, isDirectory: &isDir), !isDir.boolValue else { continue }
            out.append(rel)
        }
        return out.sorted()
    }

    private func generate() async {
        let service = KnowledgeGraphService()
        await service.generate(codeRepoRoot: repo, docRoots: [repo], memoryRoot: repo)
    }

    // MARK: - the run

    func testGenerationProducesTheCanonicalTreeWithNoDuplicates() async throws {
        await generate()
        let tree = try generatedTree()

        // 1. Everything lands under `system/`. Nothing anywhere else except the
        //    scan cache (owned by the GraphKit package, see README).
        for path in tree where !path.hasPrefix("system/") {
            XCTAssertEqual(path, ".code-notes/scan-cache.json",
                           "unexpected generated file outside system/: \(path)")
        }

        // 2. The `/graphify` skill's tree is never created.
        XCTAssertFalse(tree.contains { $0.hasPrefix("graphify-out/") },
                       "nothing may be written into graphify-out/: \(tree)")

        // 3. Exactly the expected artifacts, each exactly once.
        for expected in ["system/graph/index.md", "system/graph/graph.json",
                         "system/memory/graph-notes.md", "system/memory/doc-notes.md"] {
            XCTAssertEqual(tree.filter { $0 == expected }.count, 1,
                           "expected exactly one \(expected), tree=\(tree)")
        }

        // 4. Per-file code notes exist for the real sources.
        XCTAssertTrue(tree.contains("system/graph/src/Database.swift.md"), "\(tree)")
        XCTAssertTrue(tree.contains("system/graph/src/App.swift.md"), "\(tree)")

        // 5. No second copy of the repo overview under any name.
        let overviewLike = tree.filter { $0.hasSuffix("repo.md") }
        XCTAssertTrue(overviewLike.isEmpty, "a duplicate overview reappeared: \(overviewLike)")

        // 6. "md is doc": markdown is represented by the doc track only. A
        //    per-file CODE note for a doc (`README.md.md`) would put the same
        //    content in two places.
        let docNotes = tree.filter { $0.hasSuffix(".md.md") }
        XCTAssertTrue(docNotes.isEmpty, "markdown got a code note: \(docNotes)")
    }

    func testTheGraphActuallyDescribesTheCode() async throws {
        await generate()
        let index = try String(contentsOf: repo.appendingPathComponent("system/graph/index.md"),
                               encoding: .utf8)
        XCTAssertTrue(index.contains("Database.swift"), index)

        let notes = try String(contentsOf: repo.appendingPathComponent("system/memory/graph-notes.md"),
                               encoding: .utf8)
        // Counts are real, not zero — the scanner found symbols.
        XCTAssertFalse(notes.contains("- Code nodes: 0"), notes)
        XCTAssertFalse(notes.contains("- Doc nodes: 0"), notes)

        // The doc→code cross-link the merge step exists to produce: a backtick
        // mention of `src/Database.swift` / `backupTo` in architecture.md.
        XCTAssertTrue(notes.contains("## Doc → code references"), notes)

        let docNotes = try String(contentsOf: repo.appendingPathComponent("system/memory/doc-notes.md"),
                                  encoding: .utf8)
        XCTAssertTrue(docNotes.contains("architecture"), docNotes)
        // Declared frontmatter affinity survives into the memory artifact.
        XCTAssertTrue(docNotes.contains("src/Database.swift"), docNotes)
    }

    /// The whole point of "update, don't duplicate": a second run over unchanged
    /// sources must produce the identical tree and must not rewrite the files.
    func testSecondRunIsIdempotent() async throws {
        await generate()
        let firstTree = try generatedTree()

        let tracked = ["system/memory/graph-notes.md", "system/memory/doc-notes.md"]
        var backdated: [String: Date] = [:]
        for rel in tracked {
            let stamp = Date(timeIntervalSinceNow: -7200)
            try fm.setAttributes([.modificationDate: stamp],
                                 ofItemAtPath: repo.appendingPathComponent(rel).path)
            backdated[rel] = stamp
        }

        await generate()

        XCTAssertEqual(try generatedTree(), firstTree, "a re-run changed the file tree")
        for rel in tracked {
            let now = try fm.attributesOfItem(atPath: repo.appendingPathComponent(rel).path)[.modificationDate] as? Date
            XCTAssertEqual(now?.timeIntervalSince1970 ?? 0,
                           backdated[rel]!.timeIntervalSince1970, accuracy: 1,
                           "\(rel) was rewritten even though nothing changed")
        }
    }

    /// A real edit must flow through to the memory artifacts.
    func testEditedCodeUpdatesTheMemoryArtifacts() async throws {
        await generate()
        let notesURL = repo.appendingPathComponent("system/memory/graph-notes.md")
        let before = try String(contentsOf: notesURL, encoding: .utf8)

        try write("src/Extra.swift", "struct Extra { func helper() {} }\n")
        try runGit(["add", "-A"])
        await generate()

        let after = try String(contentsOf: notesURL, encoding: .utf8)
        XCTAssertNotEqual(before, after, "adding a source file must change the graph notes")
        XCTAssertTrue(try generatedTree().contains("system/graph/src/Extra.swift.md"))
    }

    /// A repo still holding pre-consolidation memory converges to one copy.
    func testLegacyTreeIsMigratedOnFirstGeneration() async throws {
        try write("graphify-out/memory/chat-memory.md", "# Chat memory\n- Uses SwiftPM only\n")
        try write("graphify-out/memory/graph-notes.md", "stale\n")

        await generate()

        let carried = try String(contentsOf: repo.appendingPathComponent("system/memory/chat-memory.md"),
                                 encoding: .utf8)
        XCTAssertTrue(carried.contains("Uses SwiftPM only"), "curated facts must survive")
        XCTAssertFalse(fm.fileExists(atPath: repo.appendingPathComponent("graphify-out/memory").path),
                       "legacy dir must be gone")
        XCTAssertEqual(try generatedTree().filter { $0.hasSuffix("chat-memory.md") },
                       ["system/memory/chat-memory.md"], "exactly one chat-memory.md")
    }

    /// Generated output must not show up in the user's `git status`.
    func testGeneratedOutputIsGitIgnored() async throws {
        await generate()
        let status = try runGit(["status", "--porcelain"])
        XCTAssertFalse(status.contains("system/graph/"), "graph output is not ignored:\n\(status)")
        XCTAssertFalse(status.contains("system/memory/"), "memory output is not ignored:\n\(status)")
    }
}
