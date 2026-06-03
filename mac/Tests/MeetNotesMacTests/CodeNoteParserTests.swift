import Testing
@testable import MeetNotesMac

struct CodeNoteParserTests {
    private func note(_ id: String, kind: String, links: [CodeNote.Link]) -> CodeNote {
        CodeNote(id: id, kind: kind, title: id, links: links)
    }

    @Test func derivesNodesAndEdgesFromNotes() {
        let notes = [
            note("file:a.ts", kind: "file",
                 links: [CodeNote.Link(to: "file:b.ts", kind: "imports")]),
            note("file:b.ts", kind: "file", links: []),
        ]
        let data = CodeNoteParser.derive(from: notes)
        #expect(data.nodes.count == 2)
        #expect(data.edges.count == 1)
        #expect(data.edges.first?.fromId == "file:a.ts")
        #expect(data.edges.first?.toId == "file:b.ts")
        #expect(data.edges.first?.kind == .imports)
    }

    @Test func dropsDanglingEdges() {
        // link target has no node → edge dropped.
        let notes = [
            note("file:a.ts", kind: "file",
                 links: [CodeNote.Link(to: "file:ghost.ts", kind: "imports")]),
        ]
        let data = CodeNoteParser.derive(from: notes)
        #expect(data.nodes.count == 1)
        #expect(data.edges.isEmpty)
    }

    @Test func mapsKnownNodeAndEdgeKinds() {
        let notes = [
            note("class:Foo", kind: "class",
                 links: [CodeNote.Link(to: "file:a.ts", kind: "depends_on")]),
            note("file:a.ts", kind: "file", links: []),
        ]
        let data = CodeNoteParser.derive(from: notes)
        let cls = data.nodes.first { $0.id == "class:Foo" }!
        #expect(cls.kind == .classType)
        #expect(data.edges.first?.kind == .dependsOn)
    }

    @Test func unknownKindsFallBack() {
        let notes = [
            note("x:1", kind: "alien",
                 links: [CodeNote.Link(to: "x:2", kind: "teleports")]),
            note("x:2", kind: "alien", links: []),
        ]
        let data = CodeNoteParser.derive(from: notes)
        #expect(data.nodes.first?.kind == .other)
        #expect(data.edges.first?.kind == .relatedTo)
    }
}
