import XCTest
@testable import LlmIdeMacLib

/// VerifyApprovalStore gates whether RegressionRunner.swift actually
/// executes a verify command (RegressionRunner.swift:231,
/// `approvals.isApproved(...)` — a false there means the command does
/// NOT run). Getting this hash/approval logic wrong means either a
/// command silently never runs (denial), or worse, a command that was
/// never actually approved by the user runs anyway (the real risk).
final class VerifyApprovalStoreTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "verify-approval-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    private let repo = URL(fileURLWithPath: "/Users/test/repo")
    private let fault = "2026-08-01-some-fault.md"
    private let command = "npm test -- --grep 'regression'"

    func testUnapprovedCommandIsNotApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        XCTAssertFalse(store.isApproved(repo: repo, faultFile: fault, command: command))
    }

    func testApprovingMakesItApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        store.approve(repo: repo, faultFile: fault, command: command)
        XCTAssertTrue(store.isApproved(repo: repo, faultFile: fault, command: command))
    }

    func testApprovalPersistsAcrossInstances() {
        let a = VerifyApprovalStore(defaults: suite)
        a.approve(repo: repo, faultFile: fault, command: command)

        let b = VerifyApprovalStore(defaults: suite)
        XCTAssertTrue(b.isApproved(repo: repo, faultFile: fault, command: command))
    }

    /// The core security property: approving one exact command must NOT
    /// approve a different command, even a one-character difference —
    /// otherwise a fault's verify command could be edited after approval
    /// and silently inherit trust it never earned.
    func testChangingCommandTextInvalidatesApproval() {
        let store = VerifyApprovalStore(defaults: suite)
        store.approve(repo: repo, faultFile: fault, command: command)

        XCTAssertFalse(store.isApproved(repo: repo, faultFile: fault, command: command + " "))
        XCTAssertFalse(store.isApproved(repo: repo, faultFile: fault, command: "rm -rf /"))
    }

    func testDifferentFaultFileIsNotApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        store.approve(repo: repo, faultFile: fault, command: command)
        XCTAssertFalse(store.isApproved(repo: repo, faultFile: "different-fault.md", command: command))
    }

    func testDifferentRepoIsNotApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        store.approve(repo: repo, faultFile: fault, command: command)
        let otherRepo = URL(fileURLWithPath: "/Users/test/other-repo")
        XCTAssertFalse(store.isApproved(repo: otherRepo, faultFile: fault, command: command))
    }

    /// repo.standardizedFileURL is used in the hash — a path with a
    /// redundant "./" or trailing slash must still hash identically to
    /// its canonical form, or a legitimate re-run could spuriously
    /// require re-approval.
    func testNonStandardizedRepoPathStillMatches() {
        let store = VerifyApprovalStore(defaults: suite)
        store.approve(repo: repo, faultFile: fault, command: command)
        let messyPath = URL(fileURLWithPath: "/Users/test/repo/./")
        XCTAssertTrue(store.isApproved(repo: messyPath, faultFile: fault, command: command))
    }

    func testApprovingMultipleCommandsKeepsBothApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        store.approve(repo: repo, faultFile: fault, command: command)
        store.approve(repo: repo, faultFile: "another-fault.md", command: "swift test")

        XCTAssertTrue(store.isApproved(repo: repo, faultFile: fault, command: command))
        XCTAssertTrue(store.isApproved(repo: repo, faultFile: "another-fault.md", command: "swift test"))
    }
}
