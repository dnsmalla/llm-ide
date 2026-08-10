import XCTest
@testable import LlmIdeMacLib

/// The managed `.gitignore` block is only written in full for NEW projects, so an
/// entry added later reaches every existing checkout through this retro-fit alone.
/// When it silently fails, a path that should be ignored starts getting committed —
/// which is exactly what `system/loop-runs/` would do: one JSON file per loop run,
/// forever, on a cron schedule.
final class ProjectScaffolderGitignoreTests: XCTestCase {

    private func managedBlock(_ body: String) -> String {
        "\(AppIdentity.managedBlockOpen)\n\(body)\n\(AppIdentity.managedBlockClose)\n"
    }

    // MARK: - New projects

    /// Effective rules only — comments and blanks are stripped. Asserting on the raw
    /// text would be satisfied by a path merely *mentioned* in a comment, which is
    /// how this test first passed a block that did not actually ignore anything.
    private func ignoreRules(in block: String) -> [String] {
        block
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }

    func testFullBlockIgnoresRunHistoryButNotTheContract() {
        let rules = ignoreRules(in: ProjectScaffolder.managedGitignoreBlockForTesting)
        // A brand-new project gets the block verbatim, so the run log must be ignored…
        XCTAssertTrue(rules.contains("system/loop-runs/"))
        // …and the contract must NOT be: system/loop.json is committed on purpose,
        // so the Loop reloads after a fresh clone or on a second machine.
        XCTAssertFalse(rules.contains { $0.contains("loop.json") },
                       "system/loop.json must stay tracked — it is the portable contract")
    }

    /// Leading whitespace is significant in a `.gitignore` pattern — an indented
    /// `system/loop-runs/` silently matches nothing. Swift strips a multiline
    /// literal's indent relative to its closing delimiter, so the blocks are clean
    /// today; this fails if a future edit moves a delimiter, which a `contains`
    /// check cannot see.
    func testNoManagedPatternHasLeadingWhitespace() {
        var blocks = [ProjectScaffolder.managedGitignoreBlockForTesting]
        // Every upgrade's injected text, as it would land in a real file.
        if let upgraded = ProjectScaffolder.upgradedManagedGitignore(
            managedBlock("system/cache/")) {
            blocks.append(upgraded)
        }
        for block in blocks {
            for line in block.split(separator: "\n", omittingEmptySubsequences: true) {
                let text = String(line)
                guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                XCTAssertEqual(text, text.trimmingCharacters(in: .whitespaces),
                               "gitignore line must not be indented: [\(text)]")
            }
        }
    }

    // MARK: - Existing projects

    func testOlderBlockGainsTheRunHistoryIgnore() throws {
        let existing = managedBlock("""
        system/cache/
        system/graph/
        .agents/
        """)
        let upgraded = try XCTUnwrap(ProjectScaffolder.upgradedManagedGitignore(existing))
        XCTAssertTrue(upgraded.contains("system/loop-runs/"))
        // Injected INSIDE the managed block, or git would still track the path while
        // the block looks complete.
        let ignoreIndex = try XCTUnwrap(upgraded.range(of: "system/loop-runs/")?.lowerBound)
        let closeIndex = try XCTUnwrap(upgraded.range(of: AppIdentity.managedBlockClose)?.lowerBound)
        XCTAssertLessThan(ignoreIndex, closeIndex)
    }

    /// The user's own rules live above the managed block and must never be touched.
    func testUserRulesAboveTheBlockArePreserved() throws {
        let existing = "# mine\n.DS_Store\nbuild/\n\n" + managedBlock("system/cache/\n.agents/")
        let upgraded = try XCTUnwrap(ProjectScaffolder.upgradedManagedGitignore(existing))
        XCTAssertTrue(upgraded.hasPrefix("# mine\n.DS_Store\nbuild/\n"))
    }

    /// A scaffold two versions behind must catch up on BOTH entries in one pass —
    /// the original single-`if` form could only ever apply the first.
    func testAScaffoldMissingSeveralEntriesGainsAllOfThem() throws {
        let existing = managedBlock("system/cache/\nsystem/graph/")
        let upgraded = try XCTUnwrap(ProjectScaffolder.upgradedManagedGitignore(existing))
        XCTAssertTrue(upgraded.contains(".agents/"), "agent-skills upgrade missing")
        XCTAssertTrue(upgraded.contains("system/loop-runs/"), "run-history upgrade missing")
    }

    /// Idempotent: opening an up-to-date project must not rewrite .gitignore, or
    /// every project open would dirty the working tree.
    func testAnUpToDateBlockIsLeftAlone() {
        let existing = managedBlock("""
        system/cache/
        .agents/
        system/loop-runs/
        """)
        XCTAssertNil(ProjectScaffolder.upgradedManagedGitignore(existing))
    }

    func testUpgradingTwiceIsAlsoIdempotent() throws {
        let existing = managedBlock("system/cache/\n.agents/")
        let once = try XCTUnwrap(ProjectScaffolder.upgradedManagedGitignore(existing))
        XCTAssertNil(ProjectScaffolder.upgradedManagedGitignore(once))
    }
}
