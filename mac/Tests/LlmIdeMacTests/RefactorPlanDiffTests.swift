import XCTest
@testable import LlmIdeMacLib

final class RefactorPlanDiffTests: XCTestCase {
    let plan = """
    ### R1 Split Big  (status: todo)
    - Files: `Sources/Big.swift`, `Sources/BigHelpers.swift`
    - Symbols: `Big.run`, `Big.parse`
    - Tests: missing `Sources/Big.swift`
    - Intent: split
    - Risk: low
    - Expect: filesOver500Count 3 → 2
    ### R2 Break cycle  (status: todo)
    - Files: `a.mjs`
    - Expect: cycleCount 1 → 0
    """

    func testFirstTodo() {
        let b = RefactorPlanDiff.firstTodo(in: plan)
        XCTAssertEqual(b?.id, "R1")
        XCTAssertEqual(b?.expect, "filesOver500Count")
        XCTAssertEqual(b?.files, ["Sources/Big.swift", "Sources/BigHelpers.swift"])
    }

    func testFirstTodoIsNilWhenNothingIsTodo() {
        let done = plan.replacingOccurrences(of: "(status: todo)", with: "(status: done)")
        XCTAssertNil(RefactorPlanDiff.firstTodo(in: done))
    }

    func testAppliedBatch() {
        let after = plan.replacingOccurrences(of: "R1 Split Big  (status: todo)", with: "R1 Split Big  (status: done)")
        let applied = RefactorPlanDiff.appliedBatch(before: plan, after: after)
        XCTAssertEqual(applied?.id, "R1")
        XCTAssertEqual(applied?.status, "done")
        XCTAssertEqual(applied?.expect, "filesOver500Count")
        XCTAssertNil(RefactorPlanDiff.appliedBatch(before: plan, after: plan))
    }

    func testSkippedBatchIsReportedWithItsStatus() {
        let after = plan.replacingOccurrences(of: "R2 Break cycle  (status: todo)", with: "R2 Break cycle  (status: skipped, reason: cycle is intended)")
        let applied = RefactorPlanDiff.appliedBatch(before: plan, after: after)
        XCTAssertEqual(applied?.id, "R2")
        XCTAssertEqual(applied?.status, "skipped")
    }

    func testAppliedReplyLineFallback() {
        XCTAssertEqual(RefactorPlanDiff.appliedReplyBatchId("Did it.\nApplied: R3\n"), "R3")
        XCTAssertNil(RefactorPlanDiff.appliedReplyBatchId("Nothing done."))
    }

    /// `Expect: none` (any case, with or without backticks) names no counter, so
    /// there is nothing to verify; an unknown counter name is kept for verify to report.
    func testExpectNoneMeansNoCounterToVerify() {
        for expectLine in ["none", "None", "NONE", "`none`"] {
            let before = plan.replacingOccurrences(of: "- Expect: filesOver500Count 3 → 2", with: "- Expect: \(expectLine)")
            let after = before.replacingOccurrences(of: "R1 Split Big  (status: todo)", with: "R1 Split Big  (status: done)")
            let applied = RefactorPlanDiff.appliedBatch(before: before, after: after)
            XCTAssertEqual(applied?.id, "R1", expectLine)
            XCTAssertNil(applied?.expect, expectLine)
        }
        let unknown = plan.replacingOccurrences(of: "R1 Split Big  (status: todo)", with: "R1 Split Big  (status: done)")
        XCTAssertEqual(RefactorPlanDiff.appliedBatch(before: plan, after: unknown)?.expect, "filesOver500Count")
    }

    func testSectionIsVerbatim() {
        let section = RefactorPlanDiff.section(of: "R2", in: plan)
        XCTAssertEqual(section, "### R2 Break cycle  (status: todo)\n- Files: `a.mjs`\n- Expect: cycleCount 1 → 0")
    }
}
