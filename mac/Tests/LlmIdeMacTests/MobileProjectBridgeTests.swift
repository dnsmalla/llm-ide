import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

final class MobileProjectBridgeTests: XCTestCase {
    private func decide(_ id: String = "b", recents: [String] = ["a", "b"], active: String? = "a",
                        allowed: Bool = true, exporting: Bool = false, busy: String? = nil) -> MobileProjectBridge.Decision {
        MobileProjectBridge.decide(requestedId: id, recentIds: recents, activeId: active, allowed: allowed,
                                   isExporting: exporting, busyReason: busy)
    }

    func testOnlyAnIdFromTheMacsOwnRecentsCanBeOpened() {
        XCTAssertEqual(decide("b"), .go("b"))
        if case .refuse = decide("../../etc"), case .refuse = decide("zzz") {} else { XCTFail("unknown ids must be refused") }
    }

    func testEveryRefusalReason() {
        if case .refuse(let m) = decide(allowed: false) { XCTAssertTrue(m.contains("Phone access")) } else { XCTFail() }
        if case .refuse(let m) = decide("a") { XCTAssertTrue(m.contains("already open")) } else { XCTFail() }
        if case .refuse(let m) = decide(exporting: true) { XCTAssertTrue(m.contains("exporting")) } else { XCTFail() }
        XCTAssertEqual(decide(busy: "loop running"), .refuse("loop running"))
    }

    func testTheSwitchSwitchIsCheckedBeforeAnythingElse() {
        // A disabled switch must not leak whether the id exists.
        XCTAssertEqual(decide("nope", allowed: false), .refuse(PhoneAccess.projectSwitch.deniedMessage))
    }

    func testStateCarriesNoPathsAndIsCapped() throws {
        let recents = (0..<40).map { (id: "id\($0)", name: "P\($0)", opened: Date(timeIntervalSince1970: Double($0))) }
        let state = MobileProjectBridge.state(active: (id: "id0", name: "P0"), recents: recents, error: nil)
        XCTAssertEqual(state.projects.count, MobileProjectBridge.maxProjects)
        XCTAssertEqual(state.active?.id, "id0")
        let json = String(data: try JSONEncoder().encode(state), encoding: .utf8)!
        XCTAssertFalse(json.contains("/Users"))
    }
}
