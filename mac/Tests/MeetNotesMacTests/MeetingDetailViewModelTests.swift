import Testing
@testable import MeetNotesMac
import Foundation

@MainActor
final class MeetingDetailViewModelTests {

    let tempRoot: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("md-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    @Test func loadParsesFrontmatterAndBody() async throws {
        let file = tempRoot.appendingPathComponent("x.md")
        let content = """
        ---
        id: 01HAAA
        title: "Q1"
        started_at: 2026-05-08T14:00:00Z
        ended_at: 2026-05-08T14:42:00Z
        platform: meet
        language: en
        gist: "Discussed Q1."
        tldr:
          - one
          - two
        participants: ["alice"]
        ---

        ## Summary
        body text

        ## Transcript

        [14:00:01] **alice**: hi
        """
        try content.write(to: file, atomically: true, encoding: .utf8)

        let vm = MeetingDetailViewModel(fileURL: file, api: nil)
        try await vm.load()
        #expect(vm.frontmatter?.id == "01HAAA")
        #expect(vm.frontmatter?.tldr == ["one", "two"])
        #expect(vm.summarySectionMarkdown?.contains("body text") == true)
        #expect(vm.transcript?.contains("**alice**: hi") == true)
    }
}
