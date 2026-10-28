import XCTest
import GraphCore
@testable import LlmIdeMacLib

/// Note enrichment (review findings 1 and 2): the model runs read-only and the
/// app writes the notes, and only into the project's graph dir.
final class AnalyzePhaseTests: XCTestCase {

    private var base: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        base = fm.temporaryDirectory.appendingPathComponent("analyze-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? fm.removeItem(at: base) }

    /// Fake CLI: returns a canned reply and records the arguments it was given.
    private final class FakeLauncher: ProcessLauncher, @unchecked Sendable {
        let reply: String
        var lastArguments: [String] = []
        init(reply: String) { self.reply = reply }
        func run(executable: URL, arguments: [String], currentDirectory: URL?,
                 environment: [String: String]?) async throws -> (Int32, Data, Data) {
            lastArguments = arguments
            return (0, Data(reply.utf8), Data())
        }
    }

    // MARK: - Read-only arguments

    func testRunIsReadOnlyWithNoEditOrBashAndNoPermissionEscalation() {
        let args = AnalyzePhase.arguments(prompt: "P")
        XCTAssertEqual(Array(args.prefix(2)), ["-p", "P"])
        XCTAssertEqual(valueAfter("--allowedTools", in: args), ["Read", "Glob", "Grep"])
        XCTAssertEqual(valueAfter("--disallowedTools", in: args), ["Edit", "Write", "Bash"])
        XCTAssertEqual(valueAfter("--max-turns", in: args), [String(AnalyzePhase.maxTurns)])
        XCTAssertFalse(args.contains("acceptEdits"), "no permission escalation")
        XCTAssertFalse(args.contains("--add-dir"), "the model gets no extra directory")
    }

    /// The values following a flag, up to the next flag.
    private func valueAfter(_ flag: String, in args: [String]) -> [String] {
        guard let i = args.firstIndex(of: flag) else { return [] }
        return args[(i + 1)...].prefix { !$0.hasPrefix("--") }.map { $0 }
    }

    // MARK: - Reply parsing

    func testParseKeepsOnlyBatchFilesOncePerPathWithAValidBody() {
        let reply = """
        <<<NOTE path=A.swift>>>
        note for A
        <<<END>>>
        <<<NOTE path=A.swift>>>
        second A, ignored
        <<<END>>>
        <<<NOTE path=C.swift>>>
        not in the batch
        <<<END>>>
        <<<NOTE path=B.swift>>>

        <<<END>>>
        """
        let notes = AnalyzePhase.parseNotes(reply, allowed: ["A.swift", "B.swift"])
        XCTAssertEqual(notes.map(\.path), ["A.swift"])
        XCTAssertEqual(notes.first?.body, "note for A")
    }

    func testParseDropsAnOversizedBody() {
        let big = String(repeating: "x", count: AnalyzePhase.maxNoteBytes + 1)
        let reply = "<<<NOTE path=A.swift>>>\n\(big)\n<<<END>>>"
        XCTAssertTrue(AnalyzePhase.parseNotes(reply, allowed: ["A.swift"]).isEmpty)
    }

    // MARK: - Path validation

    func testNoteURLStaysInsideTheNotesDir() {
        let dir = base.appendingPathComponent("system/graph", isDirectory: true)
        XCTAssertEqual(AnalyzePhase.noteURL(notesDir: dir, path: "Sources/A.swift")?.path,
                       dir.standardizedFileURL.path + "/Sources/A.swift.md")
        for bad in ["", "/etc/passwd", "../escape", "a/../../b", "a/./b", "a//b", "./a", "a\0b"] {
            XCTAssertNil(AnalyzePhase.noteURL(notesDir: dir, path: bad), "accepted \(bad)")
        }
    }

    // MARK: - End to end: the app writes, into the project's graph dir only

    func testRunWritesNotesIntoTheProjectGraphDirAndNothingIntoTheRepo() async throws {
        let project = base.appendingPathComponent("proj", isDirectory: true)
        try fm.createDirectory(at: project.appendingPathComponent("system"), withIntermediateDirectories: true)
        fm.createFile(atPath: project.appendingPathComponent("system/project.json").path, contents: Data("{}".utf8))
        let repo = project.appendingPathComponent("code/app", isDirectory: true)
        try fm.createDirectory(at: repo, withIntermediateDirectories: true)

        let reply = "<<<NOTE path=A.swift>>>\nthe A note\n<<<END>>>\n<<<NOTE path=../../evil>>>\nx\n<<<END>>>"
        let launcher = FakeLauncher(reply: reply)
        let scan = ScanResult(files: [.init(path: "A.swift", language: "swift", loc: 1)],
                              imports: [:], symbols: [:])
        let batch = CodeBatch(index: 0, files: ["A.swift"], neighbors: [:])

        let result = await AnalyzePhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/bin/echo"))
            .run(batch: batch, scan: scan, repoRoot: repo)

        guard case .success = result else { return XCTFail("expected success, got \(result)") }
        let note = project.appendingPathComponent("system/graph/A.swift.md")
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "the A note\n")
        XCTAssertFalse(fm.fileExists(atPath: repo.appendingPathComponent("system").path),
                       "no generated output under the cloned repo")
        XCTAssertEqual(valueAfter("--disallowedTools", in: launcher.lastArguments), ["Edit", "Write", "Bash"])
    }

    func testRunFailsWhenTheReplyHoldsNoValidNote() async throws {
        let repo = base.appendingPathComponent("code/app", isDirectory: true)
        try fm.createDirectory(at: repo, withIntermediateDirectories: true)
        let scan = ScanResult(files: [], imports: [:], symbols: [:])
        let batch = CodeBatch(index: 3, files: ["A.swift"], neighbors: [:])
        let result = await AnalyzePhase(launcher: FakeLauncher(reply: "no blocks here"),
                                        cliExecutable: URL(fileURLWithPath: "/bin/echo"))
            .run(batch: batch, scan: scan, repoRoot: repo)
        guard case .failure = result else { return XCTFail("expected failure") }
    }
}
