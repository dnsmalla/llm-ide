import Testing
import Foundation
@testable import LlmIdeMac

/// Classification of meeting `.md` files into the SOURCES sub-groups
/// (Meetings vs Mail) hinges entirely on the frontmatter `platform` value.
struct LibraryItemSourceKindTests {
    @Test("email platform classifies as mail")
    func emailIsMail() {
        #expect(LibraryItem.SourceKind(platform: "email") == .mail)
        #expect(LibraryItem.SourceKind(platform: "EMAIL") == .mail)
    }

    @Test("meeting platforms classify as meeting")
    func meetingPlatforms() {
        for p in ["meet", "teams", "zoom", "mic", "Meet"] {
            #expect(LibraryItem.SourceKind(platform: p) == .meeting)
        }
    }

    @Test("unknown or empty platform defaults to meeting")
    func unknownDefaultsToMeeting() {
        #expect(LibraryItem.SourceKind(platform: "") == .meeting)
        #expect(LibraryItem.SourceKind(platform: "slack") == .meeting)
    }

    @Test(".meetings category is titled Sources; others keep their name")
    func sectionTitle() {
        #expect(LibraryItem.Category.meetings.sectionTitle == "Sources")
        #expect(LibraryItem.Category.code.sectionTitle == "Code")
        #expect(LibraryItem.Category.notes.sectionTitle == "Notes")
        #expect(LibraryItem.Category.data.sectionTitle == "Data")
    }

    @Test("every SourceKind has display metadata for its sub-group")
    func displayMetadata() {
        for kind in LibraryItem.SourceKind.allCases {
            #expect(!kind.title.isEmpty)
            #expect(!kind.icon.isEmpty)
            #expect(!kind.emptyText.isEmpty)
        }
    }

    // MARK: - Frontmatter read (the actual on-disk classification)

    private func writeMD(_ contents: String) throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("srckind-\(UUID().uuidString).md")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    @Test("reads platform: email from frontmatter as mail")
    func readsEmailFrontmatter() throws {
        let url = try writeMD("""
        ---
        id: abc123
        title: Re: Q3 numbers
        platform: email
        language: ""
        ---

        From: a@b.com
        body text
        """)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(LibraryItemStore.sourceKind(for: url) == .mail)
    }

    @Test("reads a captured-meeting platform as meeting")
    func readsMeetingFrontmatter() throws {
        let url = try writeMD("""
        ---
        id: def456
        title: Standup
        platform: meet
        ---
        transcript
        """)
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(LibraryItemStore.sourceKind(for: url) == .meeting)
    }

    @Test("defaults to meeting when frontmatter or platform is absent")
    func defaultsWithoutFrontmatter() throws {
        let plain = try writeMD("# Just a note\nno frontmatter here")
        let noPlatform = try writeMD("---\nid: x\ntitle: y\n---\nbody")
        defer {
            try? FileManager.default.removeItem(at: plain)
            try? FileManager.default.removeItem(at: noPlatform)
        }
        #expect(LibraryItemStore.sourceKind(for: plain) == .meeting)
        #expect(LibraryItemStore.sourceKind(for: noPlatform) == .meeting)
    }
}
