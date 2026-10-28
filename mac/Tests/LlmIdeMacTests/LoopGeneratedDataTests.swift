import XCTest
@testable import LlmIdeMacLib

/// D1 for the Loop: the Loop reads the code graph and writes regression faults at
/// the PROJECT's `system/`, never under a cloned repo's `system/`. Covers the
/// single-repo flat graph, the multi-repo per-child graph, the pre-D1 legacy
/// fallback, and fault sync output.
final class LoopGeneratedDataTests: XCTestCase {

    private var base: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        base = fm.temporaryDirectory.appendingPathComponent("loop-gdl-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: base)
    }

    private func write(_ body: String, to url: URL) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try body.write(to: url, atomically: true, encoding: .utf8)
    }

    /// A project with `code/<child>` repos and a scaffolded `system/project.json`.
    private func makeProject(children: [String]) throws -> (project: URL, repos: [URL]) {
        let project = base.appendingPathComponent("proj", isDirectory: true)
        try write("{}", to: project.appendingPathComponent("system/project.json"))
        let repos = try children.map { c -> URL in
            let repo = project.appendingPathComponent("code/\(c)", isDirectory: true)
            try write("print(1)\n", to: repo.appendingPathComponent("main.py"))
            return repo
        }
        return (project, repos)
    }

    /// A graph.json 1.1 document with `count` file nodes.
    private func graphJSON(files count: Int) -> String {
        let files = (0..<count).map { i in
            #"{"path":"F\#(i).swift","language":"swift","loc":1,"imports":[],"usedBy":[],"types":[],"functions":[]}"#
        }.joined(separator: ",")
        return #"{"version":"1.1","files":[\#(files)],"calls":[]}"#
    }

    func testSingleRepoGraphWrittenAtProjectRootIsReadByLoop() throws {
        let (project, repos) = try makeProject(children: ["app"])
        try write(graphJSON(files: 3), to: project.appendingPathComponent("system/graph/graph.json"))

        let index = try XCTUnwrap(GraphIndex.load(gitRoot: repos[0]))
        XCTAssertEqual(index.files.count, 3)
        XCTAssertFalse(fm.fileExists(atPath: repos[0].appendingPathComponent("system").path),
                       "the Loop must not create generated output under the repo")
    }

    func testMultiRepoEachLoopReadsItsOwnChildGraph() throws {
        let (project, repos) = try makeProject(children: ["a", "b"])
        try write(graphJSON(files: 1), to: project.appendingPathComponent("system/graph/a/graph.json"))
        try write(graphJSON(files: 2), to: project.appendingPathComponent("system/graph/b/graph.json"))

        XCTAssertEqual(try XCTUnwrap(GraphIndex.load(gitRoot: repos[0])).files.count, 1)
        XCTAssertEqual(try XCTUnwrap(GraphIndex.load(gitRoot: repos[1])).files.count, 2)
    }

    /// N-1: a repo the migration has not moved yet still reads its legacy graph.
    func testLegacyChildGraphIsReadWhenNotMigrated() throws {
        let (_, repos) = try makeProject(children: ["app"])
        try write(graphJSON(files: 4), to: repos[0].appendingPathComponent("system/graph/graph.json"))

        XCTAssertEqual(try XCTUnwrap(GraphIndex.load(gitRoot: repos[0])).files.count, 4)
    }

    func testFaultSyncWritesFaultsAtProjectRootNotInTheRepo() throws {
        let (project, repos) = try makeProject(children: ["app"])
        let xroot = TestRoot(packageDir: "", testDir: "Tests/T", runner: .xctest,
                             command: "swift test", namingRule: "", languages: ["swift"])
        let out = try RegressionFaultSync(gitRoot: repos[0]).apply(
            diff: .init(newFailures: ["T.FooTests/testBar"], stillFailing: [], fixed: []),
            root: xroot, suiteCommand: "swift test", gitHead: nil, appVersion: "1")

        XCTAssertEqual(out.created, ["T.FooTests/testBar"])
        let projectFaults = try fm.contentsOfDirectory(
            atPath: project.appendingPathComponent("system/faults").path)
        XCTAssertEqual(projectFaults.filter { $0.hasSuffix(".md") }.count, 1)
        XCTAssertFalse(fm.fileExists(atPath: repos[0].appendingPathComponent("system").path))

        // The second sync sees the project-level fault and does not duplicate it.
        let again = try RegressionFaultSync(gitRoot: repos[0]).apply(
            diff: .init(newFailures: ["T.FooTests/testBar"], stillFailing: [], fixed: []),
            root: xroot, suiteCommand: "swift test", gitHead: nil, appVersion: "1")
        XCTAssertEqual(again.skippedExisting, ["T.FooTests/testBar"])
    }
}
