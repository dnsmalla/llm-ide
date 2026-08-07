import XCTest
@testable import LlmIdeMacLib

final class VerifyApprovalStoreLoopStageTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "verify-approval-loop-stage-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testStageCommandStartsUnapproved() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        XCTAssertFalse(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test"))
    }

    func testApproveStageMakesItApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        XCTAssertTrue(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test"))
    }

    func testEditingTheCommandRevokesApproval() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        XCTAssertFalse(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test --parallel"))
    }

    func testStageApprovalDoesNotLeakIntoFaultVerifyNamespace() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        XCTAssertFalse(store.isApproved(repo: repo, faultFile: "t1", command: "swift test"))
    }

    func testFaultVerifyApprovalDoesNotLeakIntoStageNamespace() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        store.approve(repo: repo, faultFile: "t1", command: "swift test")
        XCTAssertFalse(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test"))
    }
}
