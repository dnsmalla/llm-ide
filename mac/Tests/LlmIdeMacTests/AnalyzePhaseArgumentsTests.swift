import XCTest
@testable import LlmIdeMacLib

/// The enrichment CLI runs with the cloned repo as its cwd, but its notes land
/// in the project's `system/graph/`. These pin the arguments that let it write there.
final class AnalyzePhaseArgumentsTests: XCTestCase {

    private let project = URL(fileURLWithPath: "/tmp/proj", isDirectory: true)

    func testNotesOutsideTheRepoAreGrantedWithAddDir() {
        let repo = project.appendingPathComponent("code/app", isDirectory: true)
        let notes = project.appendingPathComponent("system/graph", isDirectory: true)
        let args = AnalyzePhase.arguments(prompt: "P", notesDir: notes, repoRoot: repo)

        XCTAssertEqual(args, ["-p", "P", "--permission-mode", "acceptEdits",
                              "--add-dir", notes.standardizedFileURL.path])
    }

    func testNotesInsideTheRepoNeedNoGrant() {
        let notes = project.appendingPathComponent("system/graph", isDirectory: true)
        let args = AnalyzePhase.arguments(prompt: "P", notesDir: notes, repoRoot: project)

        XCTAssertEqual(args, ["-p", "P", "--permission-mode", "acceptEdits"])
        XCTAssertFalse(args.contains("--add-dir"))
    }

    /// A sibling whose name merely starts with the repo's name is still outside it.
    func testSiblingWithSharedPrefixIsNotTreatedAsInside() {
        let repo = project.appendingPathComponent("code/app", isDirectory: true)
        let sibling = project.appendingPathComponent("code/app-old/system/graph", isDirectory: true)
        let args = AnalyzePhase.arguments(prompt: "P", notesDir: sibling, repoRoot: repo)

        XCTAssertTrue(args.contains("--add-dir"))
    }
}
