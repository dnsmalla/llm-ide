import XCTest
@testable import LlmIdeMacLib

/// The OS view (`Features/System`) and its Home routing: the System section is
/// the Home landing, never a menu item; the bridge decodes only the fixed
/// message contract; the configure script escapes the token; and the `open`
/// target honours disabled features.
@MainActor
final class SystemViewTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "system-view-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        suite.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private let allCompiled = Set(AppFeature.allCases)

    // MARK: Home routing

    func testSystemIsTheDefaultHomeWhenNothingWasChosen() {
        // A fresh install has no stored homeSection, so the fallback applies.
        let config = AppConfig(userDefaults: suite)
        XCTAssertEqual(config.homeSection, ShellSection.system.rawValue)
        XCTAssertEqual(
            ShellSection.resolveHome(config.homeSection, hidden: [], compiled: allCompiled), .system)
    }

    func testExplicitlyChosenHomeIsKept() {
        suite.set("gantt", forKey: "homeSection")
        let config = AppConfig(userDefaults: suite)
        XCTAssertEqual(config.homeSection, "gantt", "an explicit user choice must not be overwritten by the new default")
    }

    func testStaleHomeValueFallsBackToSystem() {
        suite.set("regression", forKey: "homeSection")
        let config = AppConfig(userDefaults: suite)
        XCTAssertEqual(config.homeSection, ShellSection.system.rawValue)
    }

    func testResolveHomeReturnsSystemWithoutAnyFeature() {
        // System has no backingFeature, so no compiled set can strand it.
        XCTAssertEqual(ShellSection.resolveHome("system", hidden: [], compiled: []), .system)
    }

    func testResolveHomeSystemIsNotSwallowedByHiddenSet() {
        XCTAssertEqual(ShellSection.resolveHome("system", hidden: ["explorer"], compiled: allCompiled), .system)
    }

    // MARK: Menu exclusion

    func testSystemIsNotAToolbarMenuItem() {
        XCTAssertFalse(ShellSection.toolbarOrder.contains(.system))
    }

    func testSystemIsNotUserHideable() {
        XCTAssertFalse(ShellSection.userHideable.contains(.system))
    }

    func testSystemIsStillOfferedAsAHomeChoice() {
        // The Settings "Home opens" picker iterates allCases; System must be
        // in it so the user can choose it.
        XCTAssertTrue(ShellSection.allCases.contains(.system))
        XCTAssertEqual(ShellSection.system.label, "System")
        XCTAssertNil(ShellSection.system.backingFeature)
    }

    // MARK: Bridge decoding

    func testDecodesTheFixedMessageContract() {
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "ready"]), .ready)
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "needToken"]), .needToken)
        XCTAssertEqual(SystemBridgeInbound.decode(["type": "open", "target": "loop"]), .open(target: "loop"))
    }

    func testIgnoresUnknownOrMalformedMessages() {
        XCTAssertNil(SystemBridgeInbound.decode(["type": "stop"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "open"]))
        XCTAssertNil(SystemBridgeInbound.decode(["type": "open", "target": ""]))
        XCTAssertNil(SystemBridgeInbound.decode(["target": "loop"]))
        XCTAssertNil(SystemBridgeInbound.decode("ready"))
        XCTAssertNil(SystemBridgeInbound.decode(NSNull()))
    }

    // MARK: Configure script

    func testConfigureScriptEscapesTheToken() throws {
        let hostile = #"tok"en\with "quotes" and \\ backslashes"#
        let config = SystemBridgeConfig(
            baseURL: "http://127.0.0.1:3456", token: hostile, theme: "midnight", projectName: "Demo")
        let script = try XCTUnwrap(SystemBridge.configureScript(config))

        let prefix = "window.llmideConfigure("
        XCTAssertTrue(script.hasPrefix(prefix))
        XCTAssertTrue(script.hasSuffix(");"))
        let json = String(script.dropFirst(prefix.count).dropLast(2))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["token"] as? String, hostile, "the token must round-trip byte-for-byte")
        XCTAssertEqual(object["baseURL"] as? String, "http://127.0.0.1:3456")
        XCTAssertEqual(object["theme"] as? String, "midnight")
        XCTAssertEqual(object["projectName"] as? String, "Demo")
    }

    func testConfigureScriptSendsNullTokenWhenSignedOut() throws {
        let config = SystemBridgeConfig(baseURL: "http://127.0.0.1:3456", token: nil, theme: "dark", projectName: nil)
        let script = try XCTUnwrap(SystemBridge.configureScript(config))
        let json = String(script.dropFirst("window.llmideConfigure(".count).dropLast(2))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertTrue(object.keys.contains("token"), "a signed-out token is an explicit null, not an omitted key")
        XCTAssertTrue(object["token"] is NSNull)
        XCTAssertTrue(object["projectName"] is NSNull)
    }

    // MARK: open target mapping

    func testOpenTargetsMapToSections() {
        let on: (AppFeature) -> Bool = { _ in true }
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "loop", isEnabled: on), .loopEngine)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "autoTasks", isEnabled: on), .autoCode)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "settings", isEnabled: on), .settings)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "library", isEnabled: on), .library)
    }

    func testOpenRejectsUnknownTargets() {
        let on: (AppFeature) -> Bool = { _ in true }
        XCTAssertNil(SystemBridge.section(forOpenTarget: "system", isEnabled: on))
        XCTAssertNil(SystemBridge.section(forOpenTarget: "../../etc", isEnabled: on))
    }

    func testOpenHonoursDisabledFeatures() {
        // Loop and Auto Tasks are backed by .autoTasks: disabled means ignored.
        let off: (AppFeature) -> Bool = { $0 != .autoTasks }
        XCTAssertNil(SystemBridge.section(forOpenTarget: "loop", isEnabled: off))
        XCTAssertNil(SystemBridge.section(forOpenTarget: "autoTasks", isEnabled: off))
        // Settings and Library have no backing feature, so they still open.
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "settings", isEnabled: off), .settings)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "library", isEnabled: off), .library)
    }

    // MARK: Navigation policy

    func testOnlyFilesInsideTheBundledPageDirectoryLoad() {
        let dir = URL(fileURLWithPath: "/Applications/LLM-IDE.app/Contents/Resources/os-view")
        XCTAssertTrue(SystemBridge.isLocalNavigation(
            dir.appendingPathComponent("index.html"), bundleDirectory: dir))
        XCTAssertTrue(SystemBridge.isLocalNavigation(
            dir.appendingPathComponent("assets/app.js"), bundleDirectory: dir))
    }

    func testRemoteAndOutsideNavigationsAreRefused() {
        let dir = URL(fileURLWithPath: "/Applications/LLM-IDE.app/Contents/Resources/os-view")
        XCTAssertFalse(SystemBridge.isLocalNavigation(URL(string: "https://example.com/x"), bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(URL(string: "about:blank"), bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(
            URL(fileURLWithPath: "/Users/someone/secret.txt"), bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(
            URL(fileURLWithPath: "/Applications/LLM-IDE.app/Contents/Resources/os-view/../secret.txt"),
            bundleDirectory: dir), "a parent-directory escape must not count as inside the bundle")
        XCTAssertFalse(SystemBridge.isLocalNavigation(nil, bundleDirectory: dir))
        XCTAssertFalse(SystemBridge.isLocalNavigation(
            dir.appendingPathComponent("index.html"), bundleDirectory: nil))
    }
}
