import Testing
import Foundation
@testable import LlmIdeMac

struct VerifyApprovalStoreTests {
    private func store() -> VerifyApprovalStore {
        let defaults = UserDefaults(suiteName: "approval-\(UUID().uuidString)")!
        return VerifyApprovalStore(defaults: defaults)
    }
    private let repo = URL(fileURLWithPath: "/tmp/repo")
    private let file = "2024-01-01T00-00-00Z-q.md"

    @Test func unknownCommandIsNotApproved() {
        #expect(store().isApproved(repo: repo, faultFile: file, command: "make test") == false)
    }

    @Test func approvedCommandIsApproved() {
        let s = store()
        s.approve(repo: repo, faultFile: file, command: "make test")
        #expect(s.isApproved(repo: repo, faultFile: file, command: "make test"))
    }

    @Test func changingCommandRearmsApproval() {
        let s = store()
        s.approve(repo: repo, faultFile: file, command: "make test")
        #expect(s.isApproved(repo: repo, faultFile: file, command: "make test-v2") == false)
    }
}
