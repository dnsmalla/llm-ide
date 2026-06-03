import Testing
import Foundation
@testable import MeetNotesMac

struct StructureGraphBuilderTests {
    private func sampleScan() -> ScanResult {
        ScanResult(
            files: [.init(path: "a.ts", language: "typescript", loc: 10),
                    .init(path: "b.ts", language: "typescript", loc: 5)],
            imports: ["a.ts": ["b.ts"], "b.ts": []],
            symbols: ["a.ts": [.init(name: "foo", kind: "function", line: 3)], "b.ts": []])
    }
    private let repo = URL(fileURLWithPath: "/repo")

    @Test func buildsFileAndSymbolNodes() {
        let g = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        #expect(g.nodes.contains { $0.id == "file:a.ts" && $0.kind == .file })
        #expect(g.nodes.contains { $0.id == "file:b.ts" })
        #expect(g.nodes.contains { $0.id == "function:a.ts:foo" && $0.kind == .function })
    }

    @Test func setsFileURLForDetailPanel() {
        let g = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        let a = g.nodes.first { $0.id == "file:a.ts" }!
        #expect(a.metadata["fileURL"] == "file:///repo/a.ts")
        #expect(a.metadata["source_file"] == "a.ts")
    }

    @Test func buildsImportAndContainsEdges() {
        let g = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        #expect(g.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "file:b.ts" && $0.kind == .imports })
        #expect(g.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "function:a.ts:foo" && $0.kind == .contains })
    }

    @Test func mergeAttachesSummaryAndSemanticEdges() {
        let skeleton = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        let note = CodeNote(id: "file:a.ts", kind: "file", title: "a.ts", path: "a.ts",
                            links: [CodeNote.Link(to: "file:b.ts", kind: "calls")],
                            body: "## Summary\nDoes the thing.\n")
        let merged = StructureGraphBuilder.merge(skeleton: skeleton, notes: [note])
        let a = merged.nodes.first { $0.id == "file:a.ts" }!
        #expect(a.metadata["summary"] == "Does the thing.")
        #expect(merged.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "file:b.ts" && $0.kind == .calls })
        // structural import edge still present
        #expect(merged.edges.contains { $0.kind == .imports && $0.fromId == "file:a.ts" })
    }

    @Test func mergeDropsDanglingSemanticEdges() {
        let skeleton = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        let note = CodeNote(id: "file:a.ts", kind: "file", title: "a.ts", path: "a.ts",
                            links: [CodeNote.Link(to: "file:ghost.ts", kind: "calls")])
        let merged = StructureGraphBuilder.merge(skeleton: skeleton, notes: [note])
        #expect(!merged.edges.contains { $0.toId == "file:ghost.ts" })
    }
}
