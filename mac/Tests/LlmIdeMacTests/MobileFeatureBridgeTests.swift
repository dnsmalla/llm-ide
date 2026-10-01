import XCTest
@testable import LlmIdeMacLib

@MainActor
private final class SpyBridge: MobileFeatureBridge {
    var handled: [String] = []
    var installs = 0
    var accepts: Bool = true
    func handle(type: String, data: Data?) -> Bool {
        handled.append(type); return accepts
    }
    func installPushObservers() { installs += 1 }
    func removePushObservers() {}
}

@MainActor
final class MobileFeatureBridgeTests: XCTestCase {
    func testManagerRoutesAutoTaskTypesToBridge() {
        let manager = MobileControlManager()
        let spy = SpyBridge()
        manager.autoTaskBridge = spy
        XCTAssertTrue(manager.routeToFeatureBridge(type: "auto_task_list", data: nil))
        XCTAssertEqual(spy.handled, ["auto_task_list"])
    }

    func testLoopTypesGoToLoopBridge() {
        let manager = MobileControlManager()
        let spy = SpyBridge()
        manager.loopBridge = spy
        XCTAssertTrue(manager.routeToFeatureBridge(type: "loop_status_list", data: nil))
        XCTAssertEqual(spy.handled, ["loop_status_list"])
    }

    func testNilBridgeStillReportsHandledSoCallerAcksUnavailable() {
        let manager = MobileControlManager()
        // No bridges installed: routing must still claim the message (true)
        // so the generic unknown-type path never sees a feature type; the
        // manager's replyFeatureUnavailable path is exercised internally.
        XCTAssertTrue(manager.routeToFeatureBridge(type: "auto_task_run", data: nil))
        XCTAssertTrue(manager.routeToFeatureBridge(type: "loop_stop", data: nil))
    }

    func testNonFeatureTypesAreNotClaimed() {
        let manager = MobileControlManager()
        XCTAssertFalse(manager.routeToFeatureBridge(type: "chat_send", data: nil))
    }

    /// Pin the two routing Sets `MobileControlManager` uses to decide which
    /// bridge a `SharedProtocol` message type belongs to. These literals are a
    /// deliberate COPY of `MobileControlManager.autoTaskMessageTypes` /
    /// `.loopMessageTypes`, not a reference to them — the point of this test
    /// is to catch drift between those Sets and the bridges' own
    /// `handle(type:data:)` switches, so it must not read the Sets it is
    /// checking. Adding a new `auto_task_*`/`loop_*` message type to
    /// `SharedProtocol` must update BOTH the owning bridge's `handle` switch
    /// AND the matching Set in `MobileControlManager` AND this test — missing
    /// any one of the three either misroutes the new type or leaves it
    /// silently unpinned here.
    func testRoutingSetsMatchHardcodedExpectedLiterals() {
        let expectedAutoTaskTypes: Set<String> = [
            "auto_task_list",
            "auto_task_toggle",
            "auto_task_run",
            "auto_task_stop",
            "auto_task_history",
            "auto_task_logs_list",
            "auto_task_setup_list",
            "auto_task_config_set",
            "auto_task_template_save",
            "auto_task_template_rename",
            "auto_task_template_delete",
        ]
        let expectedLoopTypes: Set<String> = [
            "loop_status_list",
            "loop_start",
            "loop_start_stage",
            "loop_stop",
            "loop_history",
        ]
        XCTAssertEqual(MobileControlManager.autoTaskMessageTypes, expectedAutoTaskTypes)
        XCTAssertEqual(MobileControlManager.loopMessageTypes, expectedLoopTypes)
        XCTAssertEqual(MobileControlManager.activityMessageTypes, ["activity_list", "activity_mark_seen"])
        XCTAssertEqual(MobileControlManager.generationMessageTypes, [
            "generation_options_list", "generation_run", "llmdoc_list", "llmdoc_read",
        ])
    }

    /// The capability list is what the phone uses to decide which tabs to show, so it must follow
    /// exactly which bridges are wired — not what was compiled in.
    func testAdvertisedCapabilitiesFollowTheWiredBridges() {
        XCTAssertEqual(MobileControlManager.capabilities(autoTasks: false, loop: false, generation: false),
                       ["chat", "explorer"])
        XCTAssertEqual(MobileControlManager.capabilities(autoTasks: true, loop: true, generation: false),
                       ["chat", "explorer", "auto_tasks", "loop"])
        XCTAssertEqual(MobileControlManager.capabilities(autoTasks: false, loop: false, generation: true),
                       ["chat", "explorer", "generation", "llm_doc"])
    }

    func testActivityCapabilityAppearsOnlyWithItsBridge() {
        XCTAssertTrue(MobileControlManager.capabilities(autoTasks: false, loop: false, generation: false, activity: true)
            .contains("activity"))
        XCTAssertFalse(MobileControlManager.capabilities(autoTasks: true, loop: true, generation: true)
            .contains("activity"))
    }

    func testActivityStateIsCappedTitleOnlyAndKeepsOrder() {
        let long = String(repeating: "x", count: 1_000)
        let items = (1...80).reversed().map {
            ActivityItem(id: $0, kind: $0 == 80 ? .loopEngineeringDone : nil, title: long,
                         detail: ["secret": "path/to/file"], link: "/Users/me/private",
                         createdAt: Date(timeIntervalSince1970: Double($0)))
        }
        let state = MobileActivityBridge.state(items: items, unread: 3)
        XCTAssertEqual(state.entries.count, MobileActivityBridge.maxEntries)
        XCTAssertEqual(state.entries.first?.id, 80)                       // newest first preserved
        XCTAssertEqual(state.entries.first?.kind, "loop_engineering_done")
        XCTAssertNil(state.entries.last?.kind)                            // unknown kind stays nil
        XCTAssertEqual(state.entries.first?.title.count, MobileActivityBridge.maxTitleLength)
        XCTAssertEqual(state.unread, 3)
        // Nothing but id/kind/title/time can be on the wire — no detail, no link.
        let json = String(data: try! JSONEncoder().encode(state), encoding: .utf8)!
        XCTAssertFalse(json.contains("secret"))
        XCTAssertFalse(json.contains("/Users/me"))
    }
}
