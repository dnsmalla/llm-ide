import XCTest
@testable import LlmIdeMacLib

/// Mirrors the lab's (a)/(c)/(d) checks for `RefactorRulesCollector.digest`
/// (`LoopContractLab/RefactorRulesChecks.swift` carries the full set, including
/// the symlink and fence-escaping checks that need a temp-dir walk the lab
/// already builds).
final class RefactorRulesCollectorTests: XCTestCase {
    private func makeTempDir() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("RefactorRulesCollectorTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func write(_ root: URL, _ relativePath: String, _ text: String) {
        let url = root.appendingPathComponent(relativePath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? text.write(to: url, atomically: true, encoding: .utf8)
    }

    func testOrdersRootThenNestedThenRuleDirFiles() {
        let root = makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        write(root, "CLAUDE.md", "root rules")
        write(root, "sub/AGENTS.md", "sub rules")
        write(root, ".claude/rules/a.md", "rule a")

        let digest = RefactorRulesCollector.digest(gitRoot: root, inputPath: "sub", checkCommand: nil, testCommand: nil)

        let rangeA = digest.range(of: "### CLAUDE.md")
        let rangeB = digest.range(of: "### sub/AGENTS.md")
        let rangeC = digest.range(of: "### .claude/rules/a.md")
        XCTAssertNotNil(rangeA)
        XCTAssertNotNil(rangeB)
        XCTAssertNotNil(rangeC)
        guard let rangeA, let rangeB, let rangeC else { return }
        XCTAssertLessThan(rangeA.lowerBound, rangeB.lowerBound)
        XCTAssertLessThan(rangeB.lowerBound, rangeC.lowerBound)
        XCTAssertTrue(digest.contains("root rules"))
        XCTAssertTrue(digest.contains("sub rules"))
        XCTAssertTrue(digest.contains("rule a"))
    }

    func testTruncatesASourceAtThePerSourceLineCap() {
        let root = makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }
        write(root, "CLAUDE.md", (1...500).map { "line \($0)" }.joined(separator: "\n"))

        let digest = RefactorRulesCollector.digest(gitRoot: root, inputPath: ".", checkCommand: nil, testCommand: nil)

        XCTAssertTrue(digest.contains("line 200"))
        XCTAssertFalse(digest.contains("line 201"))
        XCTAssertTrue(digest.contains("truncated"))
    }

    func testReportsNoProjectRuleFilesFoundWhenTheProjectIsEmpty() {
        let root = makeTempDir()
        defer { try? FileManager.default.removeItem(at: root) }

        let digest = RefactorRulesCollector.digest(gitRoot: root, inputPath: ".", checkCommand: nil, testCommand: nil)

        XCTAssertTrue(digest.contains("No project rule files found"))
    }
}
