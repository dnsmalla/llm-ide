import Testing
import Foundation
@testable import LlmIdeMac

struct QAEntryTests {
    @Test func encodeIncludesRequiredFrontmatterFields() throws {
        let entry = QAEntry(
            question: "How does auth work?",
            answer: "JWT with refresh tokens.",
            savedAt: Date(timeIntervalSince1970: 1_716_465_600),
            askCount: 3,
            agent: "claude_code"
        )
        let md = try entry.toMarkdown()
        #expect(md.hasPrefix("---\n"))
        #expect(md.contains("question:"))
        #expect(md.contains("answer:"))
        #expect(md.contains("ask_count: 3"))
        #expect(md.contains("agent: claude_code"))
        #expect(md.contains("2024-05-23T12:00:00Z"))
    }

    @Test func suggestedFileNameUsesTimestampPlusSlug() {
        let entry = QAEntry(
            question: "How does AUTH work?!",
            answer: "x",
            savedAt: Date(timeIntervalSince1970: 1_716_465_600),
            askCount: 3,
            agent: "claude_code"
        )
        let name = entry.suggestedFileName()
        #expect(name.hasPrefix("2024-05-23T12-00-00Z-"))
        #expect(name.contains("how-does-auth-work"))
        #expect(name.hasSuffix(".md"))
    }
}
