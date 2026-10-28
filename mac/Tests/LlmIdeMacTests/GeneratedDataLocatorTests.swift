import XCTest
@testable import LlmIdeMacLib

/// D1 (2026-10-28): generated graph/memory/faults/Q&A data lives in the
/// PROJECT's `system/`, never in a cloned repo's `system/` under `code/<child>`.
/// These tests fail if a writer or reader lands under a child repo, and cover
/// the one-time migration from the old layout plus its N-1 read fallback.
@MainActor
final class GeneratedDataLocatorTests: XCTestCase {

    private var root: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("gdl-tests-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: root)
    }

    // MARK: - Fixtures

    /// A scaffolded project: `<root>/<name>/system/project.json`.
    private func makeProject(_ name: String = "proj") throws -> URL {
        let project = root.appendingPathComponent(name, isDirectory: true)
        try write("{}", to: project.appendingPathComponent("system/project.json"))
        return project
    }

    private func makeRepo(_ child: String, in project: URL) throws -> URL {
        let repo = project.appendingPathComponent("code/\(child)", isDirectory: true)
        try fm.createDirectory(at: repo, withIntermediateDirectories: true)
        try write("print(1)\n", to: repo.appendingPathComponent("main.py"))
        return repo
    }

    private func write(_ body: String, to url: URL) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try body.write(to: url, atomically: true, encoding: .utf8)
    }

    private func exists(_ url: URL) -> Bool { fm.fileExists(atPath: url.path) }

    /// The pre-D1 layout: generated output under `<repo>/system/`.
    private func legacyOutput(in repo: URL) throws {
        try write("# Codebase Index\n", to: repo.appendingPathComponent("system/graph/index.md"))
        try write("{\"version\":\"1.1\"}", to: repo.appendingPathComponent("system/graph/graph.json"))
        try write("*\n", to: repo.appendingPathComponent("system/graph/.gitignore"))
        try write("- fact\n", to: repo.appendingPathComponent("system/memory/chat-memory.md"))
        try write("# fault\n", to: repo.appendingPathComponent("system/faults/2026-01-01-a.md"))
        try write("# qa\n", to: repo.appendingPathComponent("system/q&a/2026-01-02-b.md"))
        try write("# Project facts\n", to: repo.appendingPathComponent("system/repo.md"))
    }

    // MARK: - Resolver

    func testChildRepoResolvesToProjectRoot() throws {
        let project = try makeProject()
        let repo = try makeRepo("app", in: project)
        XCTAssertEqual(GeneratedDataLocator.projectRoot(forRepo: repo).path, (project.standardizedFileURL).path)
    }

    func testProjectRootResolvesToItself() throws {
        let project = try makeProject()
        XCTAssertEqual(GeneratedDataLocator.projectRoot(forRepo: project).path, (project.standardizedFileURL).path)
    }

    /// A project that happens to live under a folder named `code` is still its own
    /// root: the grandparent (`~/code`'s parent) holds no `system/project.json`.
    func testProjectInsideCodeFolderIsNotMistakenForAChildRepo() throws {
        let codeFolder = root.appendingPathComponent("code", isDirectory: true)
        let project = codeFolder.appendingPathComponent("myproj", isDirectory: true)
        try write("{}", to: project.appendingPathComponent("system/project.json"))
        XCTAssertEqual(GeneratedDataLocator.projectRoot(forRepo: project).path, (project.standardizedFileURL).path)
    }

    func testSingleRepoGraphIsFlatAtProjectRoot() throws {
        let project = try makeProject()
        let repo = try makeRepo("app", in: project)
        XCTAssertEqual(GeneratedDataLocator.graphDir(forRepo: repo).path, (project.appendingPathComponent("system/graph").standardizedFileURL).path)
    }

    func testMultiRepoGraphIsPerRepoSubfolder() throws {
        let project = try makeProject()
        let a = try makeRepo("a", in: project)
        let b = try makeRepo("b", in: project)
        XCTAssertEqual(GeneratedDataLocator.graphDir(forRepo: a).path, (project.appendingPathComponent("system/graph/a").standardizedFileURL).path)
        XCTAssertEqual(GeneratedDataLocator.graphDir(forRepo: b).path, (project.appendingPathComponent("system/graph/b").standardizedFileURL).path)
    }

    func testMemoryFaultsAndQAAlwaysResolveAtProjectRoot() throws {
        let project = try makeProject()
        let a = try makeRepo("a", in: project)
        _ = try makeRepo("b", in: project)
        let sys = project.appendingPathComponent("system").standardizedFileURL
        XCTAssertEqual(GeneratedDataLocator.memoryDir(forRepo: a).path, (sys.appendingPathComponent("memory")).path)
        XCTAssertEqual(GeneratedDataLocator.faultsDir(forRepo: a).path, (sys.appendingPathComponent("faults")).path)
        XCTAssertEqual(GeneratedDataLocator.qaDir(forRepo: a).path, (sys.appendingPathComponent("q&a")).path)
    }

    // MARK: - Writers never land under a child repo

    func testMemoryStoreSeedAndQAWriteUnderProjectNotChild() throws {
        let project = try makeProject()
        let repo = try makeRepo("app", in: project)
        try MemoryStore().seedIfMissing(in: repo)
        XCTAssertFalse(exists(repo.appendingPathComponent("system")),
                       "memory must not be written into the cloned repo")
        XCTAssertTrue(exists(project.appendingPathComponent("system/faults")))
        XCTAssertTrue(exists(project.appendingPathComponent("system/repo.md")))

        let entry = QAEntry(question: "Why WAL?", answer: "Readers never block writers.",
                            savedAt: Date(), askCount: 1, agent: "test")
        _ = try MemoryStore().writeQA(at: repo, entry)
        XCTAssertFalse(exists(repo.appendingPathComponent("system")))
        let qaFiles = try fm.contentsOfDirectory(
            atPath: project.appendingPathComponent("system/q&a").path)
        XCTAssertEqual(qaFiles.count, 1)
    }

    func testNoRepoLevelSystemDirIsCreatedForAnyWriter() throws {
        let project = try makeProject()
        let repo = try makeRepo("app", in: project)
        // Resolving locations must not create anything, and the legacy dir must not exist.
        _ = GeneratedDataLocator.graphDir(forRepo: repo)
        _ = GeneratedDataLocator.memoryDir(forRepo: repo)
        XCTAssertFalse(exists(repo.appendingPathComponent("system")))
    }

    // MARK: - Migration

    func testMigrationMovesMultiRepoLegacyOutputToProjectSystem() throws {
        let project = try makeProject()
        let a = try makeRepo("a", in: project)
        let b = try makeRepo("b", in: project)
        try legacyOutput(in: a)
        try write("# Codebase Index\n", to: b.appendingPathComponent("system/graph/index.md"))

        let report = GeneratedDataMigration.run(in: project)

        let sys = project.appendingPathComponent("system")
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/a/index.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/a/graph.json")))
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/b/index.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("memory/chat-memory.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("faults/2026-01-01-a.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("q&a/2026-01-02-b.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("repo.md")))
        XCTAssertFalse(exists(a.appendingPathComponent("system")), "legacy system/ must be removed")
        XCTAssertFalse(exists(b.appendingPathComponent("system")))
        XCTAssertEqual(Set(report.movedRepos), ["a", "b"])
    }

    func testMigrationSingleRepoGraphGoesFlat() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)

        GeneratedDataMigration.run(in: project)

        XCTAssertTrue(exists(project.appendingPathComponent("system/graph/index.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/app")))
        XCTAssertFalse(exists(app.appendingPathComponent("system")))
    }

    func testMigrationIsIdempotent() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        GeneratedDataMigration.run(in: project)
        let second = GeneratedDataMigration.run(in: project)
        XCTAssertEqual(second, GeneratedDataMigration.Report())
        XCTAssertTrue(exists(project.appendingPathComponent("system/graph/index.md")))
    }

    /// A repo whose `system/` holds a git-TRACKED file is user content: skipped whole.
    func testMigrationSkipsRepoWithTrackedFilesAndKeepsThemReadable() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        try git(["init", "-q"], in: app)
        try git(["add", "-f", "system/repo.md"], in: app)

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertEqual(report.skippedTrackedRepos, ["app"])
        XCTAssertTrue(exists(app.appendingPathComponent("system/repo.md")), "tracked file must not move")
        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/index.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/index.md")))

        // N-1 fallback: the reader still finds the un-migrated graph in the old place.
        XCTAssertEqual(GeneratedDataLocator.readableGraphDir(forRepo: app).path, (app.appendingPathComponent("system/graph").standardizedFileURL).path)
        XCTAssertEqual(MemoryStore().listFaults(at: app).map(\.lastPathComponent),
                       ["2026-01-01-a.md"])
    }

    /// A file already at the new root is never overwritten; the legacy copy stays.
    func testMigrationNeverOverwritesExistingNewRootFile() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try write("NEW\n", to: project.appendingPathComponent("system/faults/2026-01-01-a.md"))
        try legacyOutput(in: app)

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertEqual(try String(contentsOf: project.appendingPathComponent("system/faults/2026-01-01-a.md"),
                                  encoding: .utf8), "NEW\n")
        XCTAssertTrue(exists(app.appendingPathComponent("system/faults/2026-01-01-a.md")))
        XCTAssertEqual(report.conflicts.count, 1)
        XCTAssertTrue(report.movedRepos.isEmpty, "a repo with a conflict is not reported as cleanly moved")
    }

    func testReadableGraphDirPrefersNewLocationAfterMigration() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        GeneratedDataMigration.run(in: project)
        XCTAssertEqual(GeneratedDataLocator.readableGraphDir(forRepo: app).path, (project.appendingPathComponent("system/graph").standardizedFileURL).path)
    }

    // MARK: - Git helper

    private func git(_ args: [String], in dir: URL) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir.path] + args
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        try p.run()
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 0, "git \(args.joined(separator: " ")) failed")
    }
}
