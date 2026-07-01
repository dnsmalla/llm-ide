import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectPathsTests {
    private let root = URL(fileURLWithPath: "/tmp/proj")
    @Test func codeRoutesToCode() {
        #expect(ProjectPaths.destinationURL(root: root, category: .code, fileName: "a.swift").path == "/tmp/proj/code/a.swift")
    }
    @Test func dataRoutesToData() {
        #expect(ProjectPaths.destinationURL(root: root, category: .data, fileName: "x.csv").path == "/tmp/proj/data/x.csv")
    }
    @Test func imageRoutesToData() {
        #expect(ProjectPaths.destinationURL(root: root, category: .data, fileName: "p.png").path == "/tmp/proj/data/p.png")
        #expect(ProjectPaths.destinationURL(root: root, category: .code, fileName: "p.png").path == "/tmp/proj/data/p.png")
    }
    @Test func noteRoutesToNotes() {
        #expect(ProjectPaths.destinationURL(root: root, category: .notes, fileName: "n.md").path == "/tmp/proj/notes/n.md")
    }
    @Test func meetingsRoutesToSource() {
        #expect(ProjectPaths.destinationURL(root: root, category: .meetings, fileName: "m.md").path == "/tmp/proj/source/m.md")
    }
}
