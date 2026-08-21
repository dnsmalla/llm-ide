import XCTest
@testable import LlmIdeMacLib

/// The one shared implementation of "Run this stage only" — the desktop menu
/// action and the phone-triggered sweep both use it, so its contract is
/// pinned here: force-enable the target (even a disabled one), disable every
/// other stage, keep the full list (the journal must record the real
/// pipeline, not a fabricated one-stage config), nil for an unknown id.
final class LoopStageSoloingTests: XCTestCase {

    private func stage(_ name: String, enabled: Bool, order: Int) -> LoopStage {
        LoopStage(name: name, kind: .shellCommand, command: "true", order: order,
                  enabled: enabled)
    }

    func testSoloingDisablesEveryOtherStageAndKeepsTheFullList() throws {
        let stages = [stage("A", enabled: true, order: 0),
                      stage("B", enabled: true, order: 1),
                      stage("C", enabled: true, order: 2)]
        let soloed = try XCTUnwrap(LoopStage.soloing(stages, id: stages[1].id))
        XCTAssertEqual(soloed.count, 3, "full list survives — journal records the real pipeline")
        XCTAssertEqual(soloed.map(\.enabled), [false, true, false])
        XCTAssertEqual(soloed.map(\.name), ["A", "B", "C"], "order and identity untouched")
    }

    func testSoloingForceEnablesADisabledTarget() throws {
        let stages = [stage("A", enabled: true, order: 0),
                      stage("B", enabled: false, order: 1)]
        let soloed = try XCTUnwrap(LoopStage.soloing(stages, id: stages[1].id))
        XCTAssertEqual(soloed.map(\.enabled), [false, true])
    }

    func testSoloingReturnsNilForAnUnknownId() {
        let stages = [stage("A", enabled: true, order: 0)]
        XCTAssertNil(LoopStage.soloing(stages, id: "no-such-stage"))
    }
}
