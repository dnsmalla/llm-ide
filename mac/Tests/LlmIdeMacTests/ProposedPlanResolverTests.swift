import XCTest
@testable import LlmIdeMacLib

/// `ProposedPlanResolver` is `save-plan`'s equivalent of `ProposedEditResolver`
/// — the one place that decides where a plan lands. Unlike an edit, this never
/// reads an existing file (it only ever creates or overwrites-in-place), so
/// there's no filesystem to mock; every test here just checks the resolved
/// path/error is right.
final class ProposedPlanResolverTests: XCTestCase {

    private func args(title: String, content: String) -> PendingTool.SavePlanArgs {
        .init(title: title, content: content)
    }

    func testResolvesUnderLlmDocPlansWithTodaysDateAndASlugifiedTitle() throws {
        let plan = try ProposedPlanResolver.resolve(
            args: args(title: "Add Dark Mode Support", content: "# Plan\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        XCTAssertTrue(plan.absolutePath.hasPrefix("/tmp/proj/llm-doc/plans/"))
        XCTAssertTrue(plan.absolutePath.hasSuffix("-add-dark-mode-support.md"))
        XCTAssertEqual(plan.displayPath, (plan.absolutePath as NSString)
            .pathComponents.suffix(3).joined(separator: "/"))
        XCTAssertEqual(plan.title, "Add Dark Mode Support")
        XCTAssertEqual(plan.content, "# Plan\n")
    }

    func testSameTitleOnTheSameDayResolvesToTheSameFilename() throws {
        let a = try ProposedPlanResolver.resolve(
            args: args(title: "Dark mode", content: "v1\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        let b = try ProposedPlanResolver.resolve(
            args: args(title: "Dark mode", content: "v2\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        XCTAssertEqual(a.absolutePath, b.absolutePath,
            "re-saving the same plan should overwrite in place, not duplicate")
    }

    func testDifferentTitlesProduceDistinctFilenames() throws {
        let a = try ProposedPlanResolver.resolve(
            args: args(title: "Dark mode", content: "x\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        let b = try ProposedPlanResolver.resolve(
            args: args(title: "Light mode", content: "x\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        XCTAssertNotEqual(a.absolutePath, b.absolutePath)
    }

    func testNoOpenProjectIsRefused() {
        let result = ProposedPlanResolver.resolve(
            args: args(title: "x", content: "y\n"), projectRoot: nil)
        guard case .failure(let err) = result else { return XCTFail("expected failure") }
        XCTAssertEqual(err, .noOpenProject)
    }

    func testEmptyContentIsRefused() {
        let result = ProposedPlanResolver.resolve(
            args: args(title: "x", content: "   \n  "),
            projectRoot: URL(fileURLWithPath: "/tmp/proj"))
        guard case .failure(let err) = result else { return XCTFail("expected failure") }
        XCTAssertEqual(err, .emptyContent)
    }

    func testTitleWithUnsafeCharactersAndWhitespaceIsSlugifiedSafely() throws {
        let plan = try ProposedPlanResolver.resolve(
            args: args(title: "Fix: \"weird\" / path? <name>", content: "x\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        let filename = (plan.absolutePath as NSString).lastPathComponent
        XCTAssertFalse(filename.contains("/"))
        XCTAssertFalse(filename.contains("\""))
        XCTAssertFalse(filename.contains("?"))
        XCTAssertFalse(filename.contains("<"))
    }

    func testEmptyTitleFallsBackToUntitledPlanRatherThanAnEmptyFilename() throws {
        let plan = try ProposedPlanResolver.resolve(
            args: args(title: "   ", content: "x\n"),
            projectRoot: URL(fileURLWithPath: "/tmp/proj")
        ).get()
        XCTAssertTrue(plan.absolutePath.hasSuffix("-untitled-plan.md"))
    }

    // MARK: - Directory creation on write (mirrors confirmSavePlan's one new
    // bit of filesystem handling: llm-doc/plans/ may not exist yet, unlike an
    // update-file target which is always an existing file).

    func testWritingCreatesThePlansDirectoryWhenMissing() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("save-plan-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let plan = try ProposedPlanResolver.resolve(
            args: args(title: "New plan", content: "# Hello\n"),
            projectRoot: tmp
        ).get()
        let url = URL(fileURLWithPath: plan.absolutePath)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path),
                       "llm-doc/plans/ should not exist yet — this is the case confirmSavePlan must handle")

        // Same two calls confirmSavePlan makes: mkdir -p, then write.
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try plan.content.write(to: url, atomically: true, encoding: .utf8)

        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "# Hello\n")
    }
}
