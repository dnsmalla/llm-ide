import Testing
import Foundation
@testable import LlmIdeMac

/// Classification of `source/` `.md` files into SOURCES sub-groups now hinges
/// on `SourceRegistry` (frontmatter `platform` → source id).
struct LibraryItemSourceClassificationTests {
    @Test(".meetings category is titled Sources; others keep their name")
    func sectionTitle() {
        #expect(LibraryItem.Category.meetings.sectionTitle == "Sources")
        #expect(LibraryItem.Category.code.sectionTitle == "Code")
        #expect(LibraryItem.Category.notes.sectionTitle == "Notes")
        #expect(LibraryItem.Category.data.sectionTitle == "Data")
    }

    private func writeMD(_ contents: String) throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("srcid-\(UUID().uuidString).md")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    @Test("reads platform: email from frontmatter as the email source")
    func readsEmail() throws {
        let url = try writeMD("---\nid: abc\ntitle: Re: Q3\nplatform: email\n---\nbody")
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(LibraryItemStore.sourceId(for: url) == "email")
    }

    @Test("reads a captured-meeting platform as the meeting source")
    func readsMeeting() throws {
        let url = try writeMD("---\nid: def\ntitle: Standup\nplatform: meet\n---\nx")
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(LibraryItemStore.sourceId(for: url) == "meeting")
    }

    @Test("defaults to meeting when frontmatter or platform is absent")
    func defaults() throws {
        let plain = try writeMD("# note\nno frontmatter")
        let noPlatform = try writeMD("---\nid: x\ntitle: y\n---\nbody")
        defer {
            try? FileManager.default.removeItem(at: plain)
            try? FileManager.default.removeItem(at: noPlatform)
        }
        #expect(LibraryItemStore.sourceId(for: plain) == "meeting")
        #expect(LibraryItemStore.sourceId(for: noPlatform) == "meeting")
    }
}
