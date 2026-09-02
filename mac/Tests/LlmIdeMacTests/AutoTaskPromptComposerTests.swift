import XCTest
@testable import LlmIdeMacLib

/// What an Auto Task actually sends to the CLI, given its settings. These are
/// the rules the Settings and Template cards imply, checked without spawning a
/// subprocess.
final class AutoTaskPromptComposerTests: XCTestCase {

    private let root = URL(fileURLWithPath: "/tmp/project")

    /// The whole feature must be inert until configured: an unconfigured task
    /// composes to exactly the prompt it had before templates existed.
    func testEmptyConfigReturnsBodyUnchanged() {
        let out = AutoTaskPromptComposer.compose(body: "Review the code.",
                                                 config: AutoTaskConfig(), projectRoot: root,
                                                 writesFiles: false)
        XCTAssertEqual(out, "Review the code.")
    }

    func testSkillDirectiveIsPrepended() {
        let config = AutoTaskConfig(skillName: "code-review",
                                    skillDirective: "Use the code-review skill:")
        let out = AutoTaskPromptComposer.compose(body: "Review the code.",
                                                 config: config, projectRoot: root,
                                                 writesFiles: false)
        XCTAssertEqual(out, "Use the code-review skill:\n\nReview the code.")
    }

    func testPathsBecomeAbsoluteInTheHeaderBlock() {
        let config = AutoTaskConfig(inputPath: "llm-doc/emails", outputPath: "llm-doc/reports")
        let out = AutoTaskPromptComposer.compose(body: "Summarise.",
                                                 config: config, projectRoot: root,
                                                 writesFiles: false)
        XCTAssertTrue(out.contains("--- PATHS ---"))
        XCTAssertTrue(out.contains("/tmp/project/llm-doc/emails"))
        XCTAssertTrue(out.contains("/tmp/project/llm-doc/reports"))
        XCTAssertTrue(out.hasSuffix("Summarise."))
    }

    /// A template that places the path itself has already said where it goes;
    /// repeating it in the header block would be noise.
    func testPlaceholdersSuppressTheHeaderBlock() {
        let config = AutoTaskConfig(inputPath: "code/api")
        let out = AutoTaskPromptComposer.compose(body: "Audit every file in {{INPUT_PATH}}.",
                                                 config: config, projectRoot: root,
                                                 writesFiles: false)
        XCTAssertEqual(out, "Audit every file in /tmp/project/code/api.")
        XCTAssertFalse(out.contains("--- PATHS ---"))
    }

    /// One placeholder used, one not — only the unused path is announced.
    func testUnusedPathStillGetsAnnounced() {
        let config = AutoTaskConfig(inputPath: "code/api", outputPath: "llm-doc/reports")
        let out = AutoTaskPromptComposer.compose(body: "Audit {{INPUT_PATH}}.",
                                                 config: config, projectRoot: root,
                                                 writesFiles: false)
        XCTAssertTrue(out.contains("--- PATHS ---"))
        XCTAssertTrue(out.contains("- Output: /tmp/project/llm-doc/reports"))
        XCTAssertFalse(out.contains("- Input:"))
    }

    func testProjectRootPlaceholderIsSubstituted() {
        let out = AutoTaskPromptComposer.compose(body: "Run in {{PROJECT_ROOT}}.",
                                                 config: AutoTaskConfig(), projectRoot: root,
                                                 writesFiles: false)
        XCTAssertEqual(out, "Run in /tmp/project.")
    }

    /// Containment is enforced, not trusted: the paired iPhone can send any
    /// string, and a `.implement` task writes to whatever this returns.
    func testAbsolutePathOutsideTheProjectIsRejected() {
        XCTAssertNil(AutoTaskPromptComposer.absolutePath("/elsewhere/data", root: root))
        XCTAssertNil(AutoTaskPromptComposer.absolutePath("~/Documents", root: root))
        XCTAssertNil(AutoTaskPromptComposer.absolutePath("../../.ssh", root: root))
        XCTAssertNil(AutoTaskPromptComposer.absolutePath("code/../../etc", root: root))
    }

    /// A `..` that stays inside the project is fine — only escapes are dropped.
    func testTraversalThatStaysInsideTheProjectIsKept() {
        XCTAssertEqual(AutoTaskPromptComposer.absolutePath("code/api/../lib", root: root),
                       "/tmp/project/code/lib")
    }

    /// A read-only task must never be told to create files: its tree is
    /// reverted after the run, and an output path outside the git root would
    /// not even be reverted.
    func testReadOnlyTaskDescribesTheOutputInsteadOfWritingIt() {
        let config = AutoTaskConfig(outputPath: "llm-doc/reports")
        let readOnly = AutoTaskPromptComposer.compose(body: "Review.", config: config,
                                                      projectRoot: root, writesFiles: false)
        XCTAssertTrue(readOnly.contains("READ-ONLY"))
        XCTAssertFalse(readOnly.contains("write every file"))

        let writing = AutoTaskPromptComposer.compose(body: "Generate.", config: config,
                                                     projectRoot: root, writesFiles: true)
        XCTAssertTrue(writing.contains("write every file"))
        XCTAssertFalse(writing.contains("READ-ONLY"))
    }

    func testBlankPathsResolveToNil() {
        XCTAssertNil(AutoTaskPromptComposer.absolutePath("   ", root: root))
        XCTAssertNil(AutoTaskPromptComposer.absolutePath(nil, root: root))
    }

    /// No project open: relative paths pass through instead of resolving
    /// against nothing.
    func testRelativePathWithoutRootPassesThrough() {
        XCTAssertEqual(AutoTaskPromptComposer.absolutePath("code/api", root: nil), "code/api")
    }

    func testSkillAndPathsComposeInOrder() {
        let config = AutoTaskConfig(inputPath: "code",
                                    skillName: "code-review",
                                    skillDirective: "Use the code-review skill:")
        let out = AutoTaskPromptComposer.compose(body: "Go.", config: config, projectRoot: root,
                                                 writesFiles: false)
        let lines = out.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertEqual(lines.first, "Use the code-review skill:")
        XCTAssertEqual(lines.last, "Go.")
        XCTAssertTrue(lines.contains("--- PATHS ---"))
    }
}
