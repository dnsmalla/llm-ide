import Testing
import Foundation
@testable import LlmIdeMac

struct FaultReportVerifyFieldTests {
    private func sample(verify: String?, verifyKind: FaultReport.VerifyKind?) -> FaultReport {
        FaultReport(
            prompt: "why does login 500?", response: "missing await on token refresh",
            notes: "n", severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123", appVersion: "0.1", agent: "claude_code",
            status: .fixed, tags: ["auth"],
            verify: verify, verifyKind: verifyKind
        )
    }

    @Test func roundTripsVerifyFields() throws {
        let original = sample(verify: "swift test --filter AuthTests", verifyKind: .command)
        let md = try original.toMarkdown()
        let decoded = try FaultReport.fromMarkdown(md)
        #expect(decoded.verify == "swift test --filter AuthTests")
        #expect(decoded.verifyKind == .command)
    }

    @Test func legacyMarkdownWithoutVerifyFieldsDecodes() throws {
        let legacy = """
        ---
        prompt: old question
        response: old answer
        severity: minor
        reported_at: "2024-05-23T12:00:00Z"
        app_version: "0.1"
        agent: claude_code
        status: fixed
        tags: []
        ---
        notes body
        """
        let decoded = try FaultReport.fromMarkdown(legacy)
        #expect(decoded.verify == nil)
        #expect(decoded.verifyKind == nil)
        #expect(decoded.status == .fixed)
    }

    @Test func omitsVerifyKeysWhenNil() throws {
        let md = try sample(verify: nil, verifyKind: nil).toMarkdown()
        #expect(!md.contains("verify:"))
        #expect(!md.contains("verify_kind:"))
    }
}
