import XCTest
@testable import LlmIdeMacLib

/// `MobileControlManager.configuredPort` — the Settings-editable base port.
/// The setter stores only sane, non-privileged values and represents the
/// default by ABSENCE (so a future change to `defaultAgentPort` follows
/// automatically); the getter falls back to the default for anything else.
final class MobileControlPortTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: MobileControlManager.portDefaultsKey)
        super.tearDown()
    }

    func testUnsetFallsBackToDefault() {
        UserDefaults.standard.removeObject(forKey: MobileControlManager.portDefaultsKey)
        XCTAssertEqual(MobileControlManager.configuredPort, MobileControlManager.defaultAgentPort)
    }

    func testValidCustomPortRoundTrips() {
        MobileControlManager.configuredPort = 3200
        XCTAssertEqual(MobileControlManager.configuredPort, 3200)
    }

    func testOutOfRangeStoredValueFallsBackToDefault() {
        // A privileged or absurd value that somehow reached defaults (an old
        // build, a manual `defaults write`) must not produce a listener that
        // can never bind.
        UserDefaults.standard.set(80, forKey: MobileControlManager.portDefaultsKey)
        XCTAssertEqual(MobileControlManager.configuredPort, MobileControlManager.defaultAgentPort)
        UserDefaults.standard.set(99999, forKey: MobileControlManager.portDefaultsKey)
        XCTAssertEqual(MobileControlManager.configuredPort, MobileControlManager.defaultAgentPort)
    }

    func testSettingTheDefaultClearsTheOverride() {
        MobileControlManager.configuredPort = 3200
        MobileControlManager.configuredPort = MobileControlManager.defaultAgentPort
        XCTAssertNil(UserDefaults.standard.object(forKey: MobileControlManager.portDefaultsKey))
    }
}
