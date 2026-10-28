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

    /// The pre-D1 layout: the app's own generated output under `<repo>/system/`,
    /// named the way the writers name it.
    private func legacyOutput(in repo: URL) throws {
        try write("# Codebase Index\n", to: repo.appendingPathComponent("system/graph/index.md"))
        try write("{\"version\":\"1.1\"}", to: repo.appendingPathComponent("system/graph/graph.json"))
        try write("*\n", to: repo.appendingPathComponent("system/graph/.gitignore"))
        try write("# file note\n", to: repo.appendingPathComponent("system/graph/Sources/A.swift.md"))
        try write("- fact\n", to: repo.appendingPathComponent("system/memory/chat-memory.md"))
        try write("env\n", to: repo.appendingPathComponent("system/memory/environment.md"))
        try write("# crash\n", to: repo.appendingPathComponent("system/faults/2026-01-01T10-00-00Z-crash.md"))
        try write("# why wal\n", to: repo.appendingPathComponent("system/q&a/2026-01-02T10-00-00Z-why-wal.md"))
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

    /// A hand-authored repo.md left in the repo must not be shadowed by a project template.
    func testSeedDoesNotShadowLegacyRepoMd() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try write("# My facts\n", to: app.appendingPathComponent("system/repo.md"))
        try MemoryStore().seedIfMissing(in: app)
        XCTAssertFalse(exists(project.appendingPathComponent("system/repo.md")))
        XCTAssertEqual(try String(contentsOf: app.appendingPathComponent("system/repo.md"), encoding: .utf8), "# My facts\n")
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

    func testMigrationMovesMultiRepoGeneratedOutputToProjectSystem() throws {
        let project = try makeProject()
        let a = try makeRepo("a", in: project)
        let b = try makeRepo("b", in: project)
        try legacyOutput(in: a)
        try write("# Codebase Index\n", to: b.appendingPathComponent("system/graph/index.md"))
        try write("{\"version\":\"1.1\"}", to: b.appendingPathComponent("system/graph/graph.json"))
        try write("*\n", to: b.appendingPathComponent("system/graph/.gitignore"))

        let report = GeneratedDataMigration.run(in: project)

        let sys = project.appendingPathComponent("system")
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/a/index.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/a/graph.json")))
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/a/Sources/A.swift.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("graph/b/index.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("memory/chat-memory.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("memory/environment.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("faults/2026-01-01T10-00-00Z-crash.md")))
        XCTAssertTrue(exists(sys.appendingPathComponent("q&a/2026-01-02T10-00-00Z-why-wal.md")))
        XCTAssertFalse(exists(a.appendingPathComponent("system/graph")), "moved generated dirs are gone from the repo")
        XCTAssertFalse(exists(b.appendingPathComponent("system")), "an emptied legacy system/ is removed")
        XCTAssertEqual(Set(report.movedRepos), ["a", "b"])
    }

    func testMigrationSingleRepoGraphGoesFlat() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)

        GeneratedDataMigration.run(in: project)

        XCTAssertTrue(exists(project.appendingPathComponent("system/graph/index.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/app")))
        XCTAssertFalse(exists(app.appendingPathComponent("system/graph")))
        XCTAssertTrue(exists(app.appendingPathComponent("system/repo.md")), "hand-authored repo.md stays")
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

    /// User source that happens to sit in a folder named like a generated dir stays put.
    func testUntrackedUserFilesNamedLikeGeneratedDirsStay() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try write("my design notes\n", to: app.appendingPathComponent("system/memory/design.md"))
        try write("keep me\n", to: app.appendingPathComponent("system/faults/triage.md"))
        try write("hand notes\n", to: app.appendingPathComponent("system/q&a/faq.md"))
        try write("# readme\n", to: app.appendingPathComponent("system/graph/README.md"))

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertTrue(exists(app.appendingPathComponent("system/memory/design.md")))
        XCTAssertTrue(exists(app.appendingPathComponent("system/faults/triage.md")))
        XCTAssertTrue(exists(app.appendingPathComponent("system/q&a/faq.md")))
        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/README.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/memory/design.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/faults/triage.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/README.md")))
        XCTAssertFalse(report.unrecognised.isEmpty)
    }

    /// A graph dir without the generator's self-ignore marker is not generated output.
    func testGraphWithoutGeneratorMarkerIsNotMoved() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try write("{\"version\":\"1.1\"}", to: app.appendingPathComponent("system/graph/graph.json"))

        GeneratedDataMigration.run(in: project)

        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/graph.json")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/graph.json")))
    }

    /// Inside a recognised graph dir, a user file still stays; only generator output moves.
    func testRecognisedGraphMovesOnlyGeneratorFiles() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        try write("user data\n", to: app.appendingPathComponent("system/graph/keep.txt"))

        GeneratedDataMigration.run(in: project)

        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/keep.txt")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/keep.txt")))
        XCTAssertTrue(exists(project.appendingPathComponent("system/graph/index.md")))
    }

    /// A repo whose `system/` holds a git-TRACKED file is user content: skipped whole.
    func testMigrationSkipsRepoWithTrackedFilesAndKeepsThemReadable() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        try git(["init", "-q"], in: app)
        try git(["add", "-f", "system/memory/chat-memory.md"], in: app)

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertEqual(report.skippedTrackedRepos, ["app"])
        XCTAssertTrue(exists(app.appendingPathComponent("system/memory/chat-memory.md")), "tracked file must not move")
        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/index.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/graph/index.md")))

        // N-1 fallback: the reader still finds the un-migrated graph in the old place.
        XCTAssertEqual(GeneratedDataLocator.readableGraphDir(forRepo: app).path,
                       app.appendingPathComponent("system/graph").standardizedFileURL.path)
        XCTAssertEqual(MemoryStore().listFaults(at: app).map(\.lastPathComponent),
                       ["2026-01-01T10-00-00Z-crash.md"])
    }

    /// Git that fails must not be read as "nothing tracked": fail closed.
    func testMigrationFailsClosedWhenGitFails() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        let fake = root.appendingPathComponent("fake-git")
        try write("#!/bin/sh\necho 'xcrun: error: invalid active developer path' >&2\nexit 1\n", to: fake)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)

        let report = GeneratedDataMigration.run(in: project, gitCandidates: [fake.path])

        XCTAssertEqual(report.skippedUnsafeRepos, ["app"])
        XCTAssertTrue(report.movedRepos.isEmpty)
        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/index.md")))
    }

    func testMigrationFailsClosedWhenNoGitExecutableIsAtAKnownLocation() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)

        let report = GeneratedDataMigration.run(in: project, gitCandidates: ["/nonexistent/git"])

        XCTAssertEqual(report.skippedUnsafeRepos, ["app"])
        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/index.md")))
    }

    /// A nested checkout (a repo inside the repo's generated dir) owns its own files.
    func testMigrationSkipsNestedCheckoutInsideTheRepo() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try git(["init", "-q"], in: app)
        try legacyOutput(in: app)
        try git(["init", "-q"], in: app.appendingPathComponent("system/graph"))

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertEqual(report.skippedUnsafeRepos, ["app"])
        XCTAssertTrue(exists(app.appendingPathComponent("system/graph/index.md")))
    }

    /// A plain folder (no git at all) migrates on the name rules.
    func testPlainFolderWithoutGitIsMigrated() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertEqual(report.movedRepos, ["app"])
        XCTAssertTrue(exists(project.appendingPathComponent("system/graph/index.md")))
    }

    /// A file already at the new root is never overwritten; the legacy copy stays.
    func testMigrationNeverOverwritesExistingNewRootFile() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try write("NEW\n", to: project.appendingPathComponent("system/faults/2026-01-01T10-00-00Z-crash.md"))
        try legacyOutput(in: app)

        let report = GeneratedDataMigration.run(in: project)

        XCTAssertEqual(try String(contentsOf: project.appendingPathComponent("system/faults/2026-01-01T10-00-00Z-crash.md"),
                                  encoding: .utf8), "NEW\n")
        XCTAssertTrue(exists(app.appendingPathComponent("system/faults/2026-01-01T10-00-00Z-crash.md")))
        XCTAssertEqual(report.conflicts.count, 1)
        XCTAssertTrue(report.movedRepos.isEmpty, "a repo with a conflict is not reported as cleanly moved")
    }

    /// repo.md is hand-authored: it never moves, and the server still reads it from the repo.
    func testRepoMdStaysInTheRepo() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)

        GeneratedDataMigration.run(in: project)

        XCTAssertTrue(exists(app.appendingPathComponent("system/repo.md")))
        XCTAssertFalse(exists(project.appendingPathComponent("system/repo.md")))
    }

    func testReadableGraphDirPrefersNewLocationAfterMigration() throws {
        let project = try makeProject()
        let app = try makeRepo("app", in: project)
        try legacyOutput(in: app)
        GeneratedDataMigration.run(in: project)
        XCTAssertEqual(GeneratedDataLocator.readableGraphDir(forRepo: app).path,
                       project.appendingPathComponent("system/graph").standardizedFileURL.path)
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
