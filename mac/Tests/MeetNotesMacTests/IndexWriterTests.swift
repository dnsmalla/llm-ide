import Testing
@testable import MeetNotesMac

struct IndexWriterTests {
    @Test func rendersStatsAndGroupsByKind() {
        let notes = [
            CodeNote(id: "module:ext", kind: "module", title: "Extension", path: "ext"),
            CodeNote(id: "file:ext/a.ts", kind: "file", title: "a.ts", path: "ext/a.ts"),
            CodeNote(id: "file:ext/b.ts", kind: "file", title: "b.ts", path: "ext/b.ts"),
        ]
        let md = IndexWriter.render(notes: notes)
        #expect(md.contains("# Code Notes Index"))
        #expect(md.contains("3 notes"))
        #expect(md.contains("Extension"))
        #expect(md.contains("a.ts"))
        #expect(md.contains("b.ts"))
    }

    @Test func emptyNotesStillRendersHeader() {
        let md = IndexWriter.render(notes: [])
        #expect(md.contains("# Code Notes Index"))
        #expect(md.contains("0 notes"))
    }
}
