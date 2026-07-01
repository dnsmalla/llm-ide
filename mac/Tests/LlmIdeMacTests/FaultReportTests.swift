import Testing
import Foundation
@testable import LlmIdeMac

struct FaultReportTests {
    @Test func encodeAndDecodeRoundTrip() throws {
        let fault = FaultReport(
            prompt: "explain the auth flow",
            response: "Auth uses JWT and… (truncated)",
            notes: "It hallucinated the refresh-token endpoint.",
            severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc123def",
            appVersion: "0.1.0",
            agent: "claude_code",
            status: .open,
            tags: ["auth", "flow"]
        )

        let markdown = try fault.toMarkdown()
        let decoded = try FaultReport.fromMarkdown(markdown)

        #expect(decoded.prompt == fault.prompt)
        #expect(decoded.response == fault.response)
        #expect(decoded.notes == fault.notes)
        #expect(decoded.severity == fault.severity)
        #expect(decoded.gitHead == fault.gitHead)
        #expect(decoded.appVersion == fault.appVersion)
        #expect(decoded.agent == fault.agent)
        #expect(decoded.status == fault.status)
        #expect(decoded.tags == fault.tags)
    }

    @Test func suggestedFileNameUsesISOTimestampAndSlug() {
        let fault = FaultReport(
            prompt: "Explain THE Auth Flow!",
            response: "x", notes: "", severity: .minor,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1.0", agent: "claude_code",
            status: .open, tags: []
        )
        // 1_716_465_600 = 2024-05-23T12:00:00Z
        let name = fault.suggestedFileName()
        #expect(name.hasPrefix("2024-05-23T12-00-00Z-"))
        #expect(name.hasSuffix(".md"))
        // Slug derived from prompt: lowercase, alnum + dashes, capped.
        #expect(name.contains("explain-the-auth-flow"))
    }

    @Test func decodeMissingOptionalFieldsAcceptsDefaults() throws {
        // gitHead and tags are optional; status defaults to open if missing.
        let md = """
        ---
        prompt: "x"
        response: "y"
        severity: info
        reported_at: 2024-05-23T12:00:00Z
        app_version: "0.1.0"
        agent: claude_code
        ---
        the notes body
        """
        let decoded = try FaultReport.fromMarkdown(md)
        #expect(decoded.gitHead == nil)
        #expect(decoded.tags.isEmpty)
        #expect(decoded.status == .open)
        #expect(decoded.notes == "the notes body")
    }

    @Test func decodeRejectsMalformedFrontmatter() {
        let md = "no frontmatter here"
        #expect(throws: FaultReport.DecodeError.self) {
            _ = try FaultReport.fromMarkdown(md)
        }
    }

    @Test func statusUpdateRewritesOnlyTheStatusField() throws {
        let fault = FaultReport(
            prompt: "x", response: "y", notes: "z", severity: .minor,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: "abc", appVersion: "0.1", agent: "claude_code",
            status: .open, tags: ["a"]
        )
        let md0 = try fault.toMarkdown()
        let md1 = try FaultReport.rewritingStatus(in: md0, to: .fixed)
        let decoded = try FaultReport.fromMarkdown(md1)
        #expect(decoded.status == .fixed)
        // Everything else preserved.
        #expect(decoded.prompt == "x")
        #expect(decoded.tags == ["a"])
        #expect(decoded.notes == "z")
    }
}
