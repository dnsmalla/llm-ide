import Testing
@testable import MeetNotesMac
import Foundation

struct FrontmatterCoderTests {

    @Test func roundTripMinimal() throws {
        let original = MeetingFrontmatter(
            id: "01HXY8ABCDEF1234567890ABCD",
            title: "Q1 Planning",
            startedAt: Date(timeIntervalSince1970: 1715184000),
            endedAt: Date(timeIntervalSince1970: 1715186520),
            durationSeconds: 2520,
            participants: ["alice", "bob"],
            platform: "meet",
            language: "en",
            gist: "Discussed Q1 OKRs.",
            tldr: ["Hire 2 engineers", "Launch June 15"],
            summaryGeneratedAt: Date(timeIntervalSince1970: 1715186591),
            summaryModel: "claude-opus-4-7"
        )

        let yaml = try FrontmatterCoder.encode(original)
        let decoded = try FrontmatterCoder.decode(yaml)

        #expect(decoded.id == original.id)
        #expect(decoded.title == original.title)
        #expect(decoded.participants == original.participants)
        #expect(decoded.tldr == original.tldr)
        #expect(abs(decoded.startedAt.timeIntervalSince1970 - original.startedAt.timeIntervalSince1970) < 1)
    }

    @Test func decodePartialDuringRecording() throws {
        // A .partial.md just after creation — no end_at, no summary.
        let yaml = """
        id: 01HABC
        title: ""
        started_at: 2026-05-12T14:30:00Z
        platform: meet
        language: en
        participants: []
        tldr: []
        """
        let fm = try FrontmatterCoder.decode(yaml)
        #expect(fm.id == "01HABC")
        #expect(fm.endedAt == nil)
        #expect(fm.gist == nil)
        #expect(fm.tldr == [])
    }

    @Test func decodeUnicodeAndMultilineTitle() throws {
        let yaml = """
        id: 01HABC
        title: "Q1 計画 — Planning Session"
        started_at: 2026-05-12T14:30:00Z
        platform: meet
        language: ja
        participants: []
        gist: |
          複数行の
          要約
        tldr:
          - 採用 2 名
          - 6月15日に延期
        """
        let fm = try FrontmatterCoder.decode(yaml)
        #expect(fm.title == "Q1 計画 — Planning Session")
        #expect(fm.gist == "複数行の\n要約\n")
        #expect(fm.tldr == ["採用 2 名", "6月15日に延期"])
    }

    @Test func splitExtractsYAMLAndBodyStart() {
        let contents = """
        ---
        id: 01HABC
        title: "X"
        started_at: 2026-05-12T14:30:00Z
        platform: meet
        language: en
        participants: []
        tldr: []
        ---

        ## Transcript

        body
        """
        let split = FrontmatterCoder.split(file: contents)
        #expect(split != nil)
        #expect(split!.yaml.contains("id: 01HABC"))
        let body = String(contents[split!.bodyStart...])
        #expect(body.contains("## Transcript"))
    }
}
