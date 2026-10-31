import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

@MainActor
private final class RecordingBridge: MobileFeatureBridge {
    var handled: [String] = []
    func handle(type: String, data: Data?) -> Bool { handled.append(type); return true }
    func installPushObservers() {}
    func removePushObservers() {}
}

/// The ONE tier table: every wire message type has a tier, and the gate consults it before any bridge.
@MainActor
final class PhoneTierTableTests: XCTestCase {
    /// A new wire message type without a tier fails the build.
    func testEveryWireMessageTypeHasATier() {
        XCTAssertGreaterThan(MobileProtocol.Tag.all.count, 90)
        let missing = MobileProtocol.Tag.all.filter { PhoneTierTable.tiers[$0] == nil }
        XCTAssertEqual(missing, [], "add these wire types to PhoneTierTable: \(missing)")
    }

    func testTableHasNoStaleRows() {
        let known = Set(MobileProtocol.Tag.all)
        let stale = PhoneTierTable.tiers.keys.filter { !known.contains($0) }
        XCTAssertEqual(stale.sorted(), [], "rows for types that no longer exist")
    }

    /// Everything the Mac routes to a handler is an inbound tier: a routed type can never be classified Mac-to-phone.
    func testEveryRoutedInboundTypeIsInboundTier() {
        let routed = MobileControlManager.autoTaskMessageTypes
            .union(MobileControlManager.loopMessageTypes)
            .union(MobileControlManager.generationMessageTypes)
            .union(MobileControlManager.activityMessageTypes)
        for type in routed {
            let tier = PhoneTierTable.tiers[type]
            XCTAssertNotNil(tier, type)
            XCTAssertNotEqual(tier, .macToPhone, type)
        }
    }

    func testTheSpecClassifications() {
        let t = PhoneTierTable.tiers
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskToggle], .desktopOnly)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskConfigSet], .desktopOnly)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskTemplateSave], .desktopOnly)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskTemplateRename], .desktopOnly)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskTemplateDelete], .desktopOnly)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskRun], .approvalConfirm)
        XCTAssertEqual(t[MobileProtocol.Tag.selfHealAction], .approvalConfirm)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskList], .read)
        XCTAssertEqual(t[MobileProtocol.Tag.autoTaskSetupList], .read, "the phone keeps read access to templates/config")
    }

    func testVerdicts() {
        XCTAssertEqual(PhoneTierTable.verdict(for: "no_such_type"),
                       .refuse(code: MobileRefusalCode.unknownType,
                               message: "Your Mac doesn't know this request. Update LLM-IDE or the phone app."))
        if case .refuse(let code, _) = PhoneTierTable.verdict(for: MobileProtocol.Tag.autoTaskToggle) {
            XCTAssertEqual(code, MobileRefusalCode.desktopOnly)
        } else { XCTFail("tier D must be refused") }
        if case .refuse(let code, _) = PhoneTierTable.verdict(for: MobileProtocol.Tag.autoTaskState) {
            XCTAssertEqual(code, MobileRefusalCode.tierRefused)
        } else { XCTFail("a Mac-to-phone type must be refused inbound") }
        XCTAssertEqual(PhoneTierTable.verdict(for: MobileProtocol.Tag.autoTaskList), .allow(.read))
        XCTAssertEqual(PhoneTierTable.verdict(for: MobileProtocol.Tag.llmIdeChat), .allow(.command))
    }

    // MARK: - The gate in handleInbound, before any bridge

    private func frame(_ type: String) -> Data { Data(#"{"type":"\#(type)"}"#.utf8) }

    func testGateRefusesBeforeAnyBridgeSeesTheFrame() {
        let manager = MobileControlManager()
        let spy = RecordingBridge()
        manager.autoTaskBridge = spy
        manager.loopBridge = spy
        for type in [MobileProtocol.Tag.autoTaskToggle, MobileProtocol.Tag.autoTaskConfigSet,
                     MobileProtocol.Tag.autoTaskTemplateSave, "auto_task_made_up", "zzz_unknown",
                     MobileProtocol.Tag.autoTaskState] {
            manager.handleInbound(frame(type))
        }
        XCTAssertEqual(spy.handled, [], "no refused frame may reach a bridge")
        XCTAssertEqual(manager.logLines.filter { $0.text.hasPrefix("Tier gate refused") }.count, 6)
    }

    func testGateLetsAllowedTypesThrough() {
        let manager = MobileControlManager()
        let spy = RecordingBridge()
        manager.autoTaskBridge = spy
        manager.handleInbound(frame(MobileProtocol.Tag.autoTaskList))
        manager.handleInbound(frame(MobileProtocol.Tag.autoTaskRun))
        XCTAssertEqual(spy.handled, [MobileProtocol.Tag.autoTaskList, MobileProtocol.Tag.autoTaskRun])
    }
}
