import XCTest
@testable import LlmIdeMacLib

@MainActor
final class PhoneAccessTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        let suite = "phoneaccess-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        return d
    }

    func testReadingDefaultsOnAndWritingDefaultsOff() {
        let s = PhoneAccessSettings(defaults: freshDefaults())
        for on in [PhoneAccess.projectSwitch, .fileBrowse, .sourceControlRead, .issuesRead] {
            XCTAssertTrue(s.isAllowed(on), "\(on) is read-only/reversible, so ON by default")
        }
        for off in [PhoneAccess.issueComment, .selfHealApply, .toolApprovals] {
            XCTAssertFalse(s.isAllowed(off), "\(off) changes things, so OFF until the user opts in")
        }
    }

    func testSwitchesPersistAndNotify() {
        let d = freshDefaults()
        let s = PhoneAccessSettings(defaults: d)
        var fired = 0
        s.onChange = { fired += 1 }
        s.set(.selfHealApply, true)
        s.set(.selfHealApply, true)               // no change ⇒ no notification
        s.set(.fileBrowse, false)
        XCTAssertEqual(fired, 2)
        let reloaded = PhoneAccessSettings(defaults: d)
        XCTAssertTrue(reloaded.isAllowed(.selfHealApply))
        XCTAssertFalse(reloaded.isAllowed(.fileBrowse))
    }

    func testRegisteredCapabilitiesHonourTheirSwitch() {
        final class Stub: MobileFeatureBridge {
            func handle(type: String, data: Data?) -> Bool { false }
            func installPushObservers() {}
            func removePushObservers() {}
        }
        let entry = MobileControlManager.RegisteredBridge(
            bridge: Stub(), messageTypes: ["x"],
            capabilities: [(name: "self_heal", gate: nil), (name: "self_heal_apply", gate: .selfHealApply)])
        XCTAssertEqual(MobileControlManager.registeredCapabilities([entry], isAllowed: { _ in false }), ["self_heal"])
        XCTAssertEqual(MobileControlManager.registeredCapabilities([entry], isAllowed: { _ in true }),
                       ["self_heal", "self_heal_apply"])
    }

    func testDeniedMessageNamesTheSetting() {
        XCTAssertTrue(PhoneAccess.selfHealApply.deniedMessage.contains("Phone access"))
    }
}
