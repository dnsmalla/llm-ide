import Foundation
import Testing
@testable import LlmIdeMacLib

/// D6: the Loop's machine data (`llm-doc/loop/...` JSON) moves to `system/loop/`.
/// Each moved file is exercised with a real old-format fixture from
/// `Fixtures/loop-d6/` (the shapes the pre-D6 encoders wrote).
@Suite("LoopDataMigration (D6: machine data out of llm-doc/loop)")
struct LoopDataMigrationTests {

    private func fixtureURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/loop-d6", isDirectory: true)
            .appendingPathComponent(name)
    }

    private func tmpRepo() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-d6-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// Writes `fixture` at `relative` under `root`, creating folders as needed.
    private func place(_ fixture: String, at relative: String, under root: URL) throws -> Data {
        let data = try Data(contentsOf: fixtureURL(fixture))
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
        return data
    }

    private func exists(_ relative: String, under root: URL) -> Bool {
        FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path)
    }

    /// (fixture, legacy path, new path) for every moved file.
    private static let cases: [(fixture: String, legacy: String, current: String)] = [
        ("ledger.json", "llm-doc/loop/test/ledger.json", "system/loop/test/ledger.json"),
        ("TEST-MAP.json", "llm-doc/loop/test/TEST-MAP.json", "system/loop/test/TEST-MAP.json"),
        ("TEST-STRUCTURE.json", "llm-doc/loop/test/TEST-STRUCTURE.json", "system/loop/test/TEST-STRUCTURE.json"),
        ("before.json", "llm-doc/loop/refactor/graph/before.json", "system/loop/refactor/graph/before.json"),
        ("after.json", "llm-doc/loop/refactor/graph/after.json", "system/loop/refactor/graph/after.json"),
    ]

    @Test("the layout constants point the machine data at system/loop and keep the .md outputs in llm-doc")
    func layoutConstants() {
        #expect(LoopOutputLayout.testLedger == "system/loop/test/ledger.json")
        #expect(LoopOutputLayout.testMapJSON == "system/loop/test/TEST-MAP.json")
        #expect(LoopOutputLayout.testStructureJSON == "system/loop/test/TEST-STRUCTURE.json")
        #expect(LoopOutputLayout.refactorGraphBefore == "system/loop/refactor/graph/before.json")
        #expect(LoopOutputLayout.refactorGraphAfter == "system/loop/refactor/graph/after.json")
        // Human-readable outputs stay where they were.
        #expect(LoopOutputLayout.testMapMD == "llm-doc/loop/test/TEST-MAP.md")
        #expect(LoopOutputLayout.refactorGraphMD == "llm-doc/loop/refactor/GRAPH.md")
    }

    @Test("the project layout names the new machine-data and note-index locations")
    func projectLayoutPaths() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let layout = ProjectLayout(root: root)
        #expect(LoopOutputLayout.dataRoot == "system/loop")
        #expect(layout.systemDir.appendingPathComponent(ProjectLayout.loopDataDirName).path == "/tmp/proj/system/loop")
        #expect(layout.notesIndex.path == "/tmp/proj/system/cache/notes-index.json")
        #expect(layout.legacyNotesIndex.path == "/tmp/proj/llm-doc/index.json")
    }

    @Test("every old-format file moves byte for byte, the legacy copy is removed, and the moved file still decodes")
    func movesEveryFileVerbatim() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        var originals: [String: Data] = [:]
        for c in Self.cases { originals[c.current] = try place(c.fixture, at: c.legacy, under: repo) }

        let results = LoopDataMigration.perform(gitRoot: repo)
        #expect(results.count == Self.cases.count)
        #expect(results.allSatisfy { $0.outcome == .moved })
        for c in Self.cases {
            #expect(!exists(c.legacy, under: repo), "\(c.legacy) should be gone")
            let moved = try Data(contentsOf: repo.appendingPathComponent(c.current))
            #expect(moved == originals[c.current], "\(c.current) must be byte-identical")
        }
        // The moved files are the same shapes the readers decode.
        let ledger = try #require(TestLedger.load(gitRoot: repo))
        #expect(ledger.runId == "run-2026-10-20-001")
        #expect(ledger.failing == ["LlmIdeMacTests/FooTests/testBarFails"])
        let map = try JSONDecoder.iso8601().decode(TestMap.self, from: Data(contentsOf: repo.appendingPathComponent("system/loop/test/TEST-MAP.json")))
        #expect(map.entries.count == 2)
        let structure = try JSONDecoder.iso8601().decode(TestStructure.self, from: Data(contentsOf: repo.appendingPathComponent("system/loop/test/TEST-STRUCTURE.json")))
        #expect(structure.roots.first?.runner == .xctest)
        let graph = try JSONDecoder().decode(GraphIndex.self, from: Data(contentsOf: repo.appendingPathComponent("system/loop/refactor/graph/before.json")))
        #expect(graph.files.first?.path == "Sources/Billing/Totals.swift")
        // The graph directory held only the two JSON files, so it is gone too.
        #expect(!exists("llm-doc/loop/refactor/graph", under: repo))
    }

    @Test("a second run finds nothing to move (idempotent)")
    func idempotent() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        for c in Self.cases { _ = try place(c.fixture, at: c.legacy, under: repo) }
        _ = LoopDataMigration.perform(gitRoot: repo)

        let second = LoopDataMigration.perform(gitRoot: repo)
        #expect(second.allSatisfy { $0.outcome == .nothingToMove })
    }

    @Test("an existing new file is never overwritten; the legacy copy is kept")
    func neverOverwritesNewFile() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let legacy = try place("ledger.json", at: "llm-doc/loop/test/ledger.json", under: repo)
        let newer = Data("{\"runId\":\"newer\"}".utf8)
        let newURL = repo.appendingPathComponent("system/loop/test/ledger.json")
        try FileManager.default.createDirectory(at: newURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try newer.write(to: newURL)

        let results = LoopDataMigration.perform(gitRoot: repo)
        #expect(results.first { $0.legacy == "llm-doc/loop/test/ledger.json" }?.outcome == .destinationExists)
        #expect(try Data(contentsOf: newURL) == newer)
        #expect(try Data(contentsOf: repo.appendingPathComponent("llm-doc/loop/test/ledger.json")) == legacy)
    }

    @Test("N-1: a project that still has only the legacy file is read from it, and the new reader writes the new file")
    func legacyOnlyStillReadable() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        _ = try place("ledger.json", at: "llm-doc/loop/test/ledger.json", under: repo)

        // Read before any migration has run.
        let before = try #require(TestLedger.load(gitRoot: repo))
        #expect(before.runId == "run-2026-10-20-001")
        #expect(LoopDataMigration.resolve(legacy: LoopOutputLayout.Legacy.testLedger,
                                          current: LoopOutputLayout.testLedger, gitRoot: repo).path
                == repo.appendingPathComponent("llm-doc/loop/test/ledger.json").path)

        // A new write lands in system/loop and retires the legacy copy it supersedes.
        var next = before
        next.runId = "run-next"
        try next.write(gitRoot: repo)
        #expect(exists("system/loop/test/ledger.json", under: repo))
        #expect(!exists("llm-doc/loop/test/ledger.json", under: repo))
        #expect(TestLedger.load(gitRoot: repo)?.runId == "run-next")
    }

    @Test("a legacy file that is a symbolic link is refused, never followed")
    func symlinkRefused() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let target = try place("ledger.json", at: "elsewhere/ledger.json", under: repo)
        let legacy = repo.appendingPathComponent("llm-doc/loop/test/ledger.json")
        try FileManager.default.createDirectory(at: legacy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: legacy, withDestinationURL: repo.appendingPathComponent("elsewhere/ledger.json"))

        let outcome = LoopDataMigration.perform(gitRoot: repo).first { $0.legacy == "llm-doc/loop/test/ledger.json" }?.outcome
        if case .refused = outcome {} else { Issue.record("expected .refused, got \(String(describing: outcome))") }
        #expect(!exists("system/loop/test/ledger.json", under: repo))
        #expect(try Data(contentsOf: repo.appendingPathComponent("elsewhere/ledger.json")) == target)
    }

    @Test("the machine data under system/loop is protected from repair edits, like the faults and the loop contract")
    func newLocationIsProtectedFromRepairs() {
        let globs = GitRepairScopeGuard.defaultProtectedGlobs
        func protected(_ path: String) -> Bool {
            globs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
        // The verdict inputs: the ledger, the test map and structure, the graph snapshots.
        for path in ["system/loop/test/ledger.json", "system/loop/test/TEST-MAP.json",
                     "system/loop/test/TEST-STRUCTURE.json", "system/loop/refactor/graph/before.json",
                     "system/loop/refactor/graph/after.json", "app/system/loop/test/ledger.json"] {
            #expect(protected(path), "\(path) must be protected from repair edits")
        }
        // The loop contract and the human-readable outputs are not machine data.
        #expect(protected("system/loop.json"))
        // `**/test/**` also matches the test folder's markdown, so only the graph notes are checked as unprotected.
        #expect(!protected("llm-doc/loop/refactor/GRAPH.md"))
    }
    @Test("a corrupt new ledger does not hide an intact legacy one: the legacy history is read and the corrupt file is quarantined")
    func corruptNewLedgerFallsBackToLegacy() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let legacy = try place("ledger.json", at: "llm-doc/loop/test/ledger.json", under: repo)
        let garbled = Data("{\"runId\": not-json".utf8)
        let newURL = repo.appendingPathComponent("system/loop/test/ledger.json")
        try FileManager.default.createDirectory(at: newURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try garbled.write(to: newURL)

        let ledger = try #require(TestLedger.load(gitRoot: repo))
        #expect(ledger.runId == "run-2026-10-20-001", "the legacy history must be the diff baseline")
        #expect(ledger.failing == ["LlmIdeMacTests/FooTests/testBarFails"])

        // The corrupt file is set aside, not overwritten, and the legacy copy is still there until a write.
        #expect(!exists("system/loop/test/ledger.json", under: repo))
        let quarantined = try FileManager.default.contentsOfDirectory(
            atPath: repo.appendingPathComponent("system/loop/test").path)
            .filter { $0.hasPrefix("ledger.json.corrupt-") }
        #expect(quarantined.count == 1)
        if let name = quarantined.first {
            #expect(try Data(contentsOf: repo.appendingPathComponent("system/loop/test/\(name)")) == garbled)
        }
        #expect(try Data(contentsOf: repo.appendingPathComponent("llm-doc/loop/test/ledger.json")) == legacy)
    }

    @Test("with neither ledger valid, the reader reports nothing rather than inventing history")
    func bothCorruptReadsNil() throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        _ = try place("ledger.json", at: "llm-doc/loop/test/ledger.json", under: repo)
        try Data("garbage".utf8).write(to: repo.appendingPathComponent("llm-doc/loop/test/ledger.json"))
        let newURL = repo.appendingPathComponent("system/loop/test/ledger.json")
        try FileManager.default.createDirectory(at: newURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("garbage".utf8).write(to: newURL)

        #expect(TestLedger.load(gitRoot: repo) == nil)
    }

}

private extension JSONDecoder {
    static func iso8601() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
