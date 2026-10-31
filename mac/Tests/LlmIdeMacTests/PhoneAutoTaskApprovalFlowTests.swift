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
        XCTAssertEqual(MobileAutoTaskBridge.tasksNeedingDesktopApproval(taskId: "implementIssues", isEnabled: { _ in true }),
                       [.implementIssues])
        XCTAssertEqual(MobileAutoTaskBridge.tasksNeedingDesktopApproval(taskId: "reviewMerge", isEnabled: { _ in false }),
                       [.reviewMerge])
        XCTAssertEqual(MobileAutoTaskBridge.tasksNeedingDesktopApproval(taskId: "reviewCode", isEnabled: { _ in true }), [])
        XCTAssertEqual(MobileAutoTaskBridge.tasksNeedingDesktopApproval(taskId: "no-such", isEnabled: { _ in true }), [])
        XCTAssertEqual(MobileAutoTaskBridge.tasksNeedingDesktopApproval(taskId: nil, isEnabled: { $0 == .reviewMerge }),
                       [.reviewMerge], "run-all names the risky tasks that are enabled")
        XCTAssertEqual(MobileAutoTaskBridge.tasksNeedingDesktopApproval(taskId: nil, isEnabled: { _ in false }), [])
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
