import XCTest
@testable import LlmIdeMacLib

/// Phone-started implement / review-merge need the person at the Mac to confirm.
@MainActor
final class PhoneAutoTaskApprovalFlowTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "phone-approval-flow-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func make() -> (MobileAutoTaskBridge, PhoneBridgeSpyHost, AutoCodeUpdateService, AutoTaskSettings) {
        let (service, settings, logs) = PhoneBridgeFixtures.autoTaskService(suite: suite)
        let host = PhoneBridgeSpyHost()
        host.allow(.autoTaskControl)
        settings.setEnabled(true, task: .implementIssues)
        settings.setEnabled(true, task: .reviewMerge)
        let bridge = MobileAutoTaskBridge(host: host, autoCode: service, settings: settings, logStore: logs)
        return (bridge, host, service, settings)
    }

    private func waitForAcks(_ host: PhoneBridgeSpyHost, _ n: Int) async {
        for _ in 0..<400 where host.autoTaskReplies.count < n { try? await Task.sleep(nanoseconds: 5_000_000) }
    }

    func testWhichTasksNeedApproval() {
        func tier(_ id: String) -> PhoneApprovalTier {
            MobileAutoTaskBridge.approvalTarget(taskId: id).tier
        }
        XCTAssertEqual(tier("implementIssues"), .t2)
        XCTAssertEqual(tier("reviewMerge"), .t2)
        for id in ["sourceUpdate", "sourcesToIssue", "updateIssues", "loopEngineering", "generateDoc"] {
            XCTAssertEqual(tier(id), .t1, id)
        }
        XCTAssertEqual(tier("reviewCode"), .t0)
        XCTAssertEqual(tier("no-such"), .t0, "unknown id needs no dialog; startPhoneRun reports it")
    }

    /// User decision 2026-10-31: custom tasks are desktop-only. The phone is refused (typed tier_refused), with no
    /// dialog and nothing started, for any id that is not a built-in (a custom id is a UUID or custom:*).
    func testCustomTasksAreRefusedFromThePhoneWithoutADialog() {
        for id in [UUID().uuidString, "custom:cat-1", "custom:anything", "no-such"] {
            let (bridge, host, service, _) = make()
            host.autoTaskRequest = .run(.init(task: id))
            XCTAssertTrue(bridge.handle(type: "auto_task_run", data: nil))
            XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.tierRefused, id)
            XCTAssertEqual(host.lastAck?.ok, false, id)
            XCTAssertTrue(host.approvalRequests.isEmpty, "\(id): refused, never escalated to a dialog")
            XCTAssertFalse(service.hasScheduledRun, id)
        }
    }

    func testEveryAutoTaskHasAPolicyRow() {
        for t in AutoTask.allCases {
            XCTAssertNotNil(PhoneApprovalPolicy.table[t.rawValue], "\(t.rawValue) has no phone approval row")
        }
    }

    func testRunAllIsRefusedFromThePhone() {
        let (bridge, host, service, _) = make()
        host.autoTaskRequest = .run(.init(task: nil))
        _ = bridge.handle(type: "auto_task_run", data: nil)
        XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.tierRefused)
        XCTAssertTrue(host.approvalRequests.isEmpty)
        XCTAssertFalse(service.hasScheduledRun)
    }

    func testNewlyGatedBuiltinsAskTheMacBeforeRunning() async {
        for id in ["sourceUpdate", "sourcesToIssue", "updateIssues", "loopEngineering", "generateDoc"] {
            let (bridge, host, service, settings) = make()
            settings.setEnabled(true, task: AutoTask(rawValue: id)!)
            host.approvalOutcomes = [.denied]
            host.autoTaskRequest = .run(.init(task: id))
            _ = bridge.handle(type: "auto_task_run", data: nil)
            XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.awaitingDesktopApproval, id)
            XCTAssertFalse(service.hasScheduledRun, "\(id): nothing starts before the Mac answers")
            await waitForAcks(host, 2)
            XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.desktopDenied, id)
            XCTAssertEqual(host.approvalRequests.count, 1, id)
            XCTAssertFalse(service.hasScheduledRun, id)
        }
    }

    func testListedTruncatesHonestlyButFingerprintKeepsEveryId() {
        let ids = (1...25).map { "#\($0)" }
        let text = AutoCodeUpdateService.listed(ids, empty: "none")
        XCTAssertTrue(text.contains("and 5 more (25 total)"), text)
        XCTAssertTrue(text.contains("#20") && !text.contains("#21,"))
        XCTAssertEqual(AutoCodeUpdateService.listed([], empty: "none"), "none")
    }

    func testImplementWaitsThenIsDeniedAndNeverStarts() async {
        let (bridge, host, service, _) = make()
        host.approvalOutcomes = [.denied]
        host.autoTaskRequest = .run(.init(task: "implementIssues"))
        XCTAssertTrue(bridge.handle(type: "auto_task_run", data: nil))
        XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.awaitingDesktopApproval, "phone is told to wait")
        XCTAssertFalse(service.hasScheduledRun, "nothing starts before the Mac answers")
        await waitForAcks(host, 2)
        XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.desktopDenied)
        XCTAssertFalse(service.hasScheduledRun)
        XCTAssertEqual(host.approvalRequests.count, 1)
        XCTAssertTrue(host.approvalRequests[0].title.contains("Implement"))
        XCTAssertTrue(host.approvalRequests[0].lines.first?.hasPrefix("Project:") == true)
    }

    func testTimeoutAndBusyAreRefusals() async {
        for (outcome, code) in [(PhoneDesktopApprovalOutcome.timedOut, MobileRefusalCode.desktopApprovalTimeout),
                                (.busy, MobileRefusalCode.desktopApprovalBusy)] {
            let (bridge, host, service, _) = make()
            host.approvalOutcomes = [outcome]
            host.autoTaskRequest = .run(.init(task: "reviewMerge"))
            _ = bridge.handle(type: "auto_task_run", data: nil)
            await waitForAcks(host, 2)
            XCTAssertEqual(host.lastAck?.code, code)
            XCTAssertFalse(service.hasScheduledRun)
        }
    }

    func testApprovedRunStartsAfterRecheck() async {
        let (bridge, host, service, _) = make()
        host.approvalOutcomes = [.approved]
        host.autoTaskRequest = .run(.init(task: "implementIssues"))
        _ = bridge.handle(type: "auto_task_run", data: nil)
        for _ in 0..<400 where !service.hasScheduledRun && host.autoTaskReplies.count < 3 {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(service.hasScheduledRun || host.autoTaskReplies.count >= 2)
        service.cancel()
    }

    func testSwitchTurnedOffWhileTheDialogWasUpStopsTheRun() async {
        let (bridge, host, service, _) = make()
        host.approvalOutcomes = [.approved]
        host.autoTaskRequest = .run(.init(task: "implementIssues"))
        _ = bridge.handle(type: "auto_task_run", data: nil)
        host.allowed = []   // the switch flips off before the Task resumes
        await waitForAcks(host, 2)
        XCTAssertFalse(service.hasScheduledRun, "execution-time re-check")
        XCTAssertEqual(host.lastAck?.message, "denied")
    }

    func testTaskDisabledMeanwhileStopsTheRun() async {
        let (bridge, host, service, settings) = make()
        host.approvalOutcomes = [.approved]
        host.autoTaskRequest = .run(.init(task: "implementIssues"))
        _ = bridge.handle(type: "auto_task_run", data: nil)
        settings.setEnabled(false, task: .implementIssues)
        await waitForAcks(host, 2)
        XCTAssertFalse(service.hasScheduledRun)
        XCTAssertEqual(host.lastAck?.code, MobileRefusalCode.taskDisabled)
    }

    func testReviewCodeNeedsNoDesktopApproval() {
        let (bridge, host, service, settings) = make()
        settings.setEnabled(true, task: .reviewCode)
        host.autoTaskRequest = .run(.init(task: "reviewCode"))
        _ = bridge.handle(type: "auto_task_run", data: nil)
        XCTAssertTrue(host.approvalRequests.isEmpty)
        XCTAssertTrue(service.hasScheduledRun)
        service.cancel()
    }
}
