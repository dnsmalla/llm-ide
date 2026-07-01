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

    @Test func csvIncludesVerifyColumn() throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("csv-verify-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, sample(verify: "make test", verifyKind: .command))

        let csvURL = try store.exportFaultsCSV(at: repo)
        let csv = try String(contentsOf: csvURL, encoding: .utf8)
        let header = csv.split(separator: "\n").first.map(String.init) ?? ""
        #expect(header.contains("verify"))
        #expect(csv.contains("\"make test\""))
    }
}
