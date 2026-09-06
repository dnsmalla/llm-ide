import XCTest
@testable import LlmIdeMac

final class DocGenTreeSelectionTests: XCTestCase {

    private func file(_ path: String) -> FSNode {
        let item = LibraryItem(name: URL(fileURLWithPath: path).lastPathComponent,
                               path: path,
                               category: .code)
        return FSNode(id: path, name: item.name,
                      url: URL(fileURLWithPath: path), item: item, children: [])
    }

    private func folder(_ path: String, _ children: [FSNode]) -> FSNode {
        FSNode(id: path, name: URL(fileURLWithPath: path).lastPathComponent,
               url: URL(fileURLWithPath: path), item: nil, children: children)
    }

    private func tree() -> FSNode {
        folder("/repo", [
            folder("/repo/src", [file("/repo/src/a.swift"), file("/repo/src/b.swift")]),
            file("/repo/README.md"),
        ])
    }

    func testFileLeavesCollectsRecursively() {
        XCTAssertEqual(
            DocGenTreeSelection.fileLeaves(of: tree()).map(\.path).sorted(),
            ["/repo/README.md", "/repo/src/a.swift", "/repo/src/b.swift"])
    }

    func testStateIsNoneWhenNothingSelected() {
        XCTAssertEqual(DocGenTreeSelection.state(for: tree(), selected: []), .none)
    }

    func testStateIsPartialWithSomeSelected() {
        let selected: Set<DocGenSource> = [
            .file(url: URL(fileURLWithPath: "/repo/src/a.swift"), name: "a.swift")
        ]
        XCTAssertEqual(DocGenTreeSelection.state(for: tree(), selected: selected), .partial)
    }

    func testStateIsAllWhenEveryLeafSelected() {
        let selected = Set(DocGenTreeSelection.fileLeaves(of: tree()).map {
            DocGenSource.file(url: $0.url, name: $0.name)
        })
        XCTAssertEqual(DocGenTreeSelection.state(for: tree(), selected: selected), .all)
    }

    func testTogglingAFolderSelectsEveryLeafBeneathIt() {
        let result = DocGenTreeSelection.toggled(node: tree(), selected: [])
        XCTAssertEqual(result.count, 3)
    }

    func testTogglingAFullySelectedFolderClearsIt() {
        let full = DocGenTreeSelection.toggled(node: tree(), selected: [])
        XCTAssertTrue(DocGenTreeSelection.toggled(node: tree(), selected: full).isEmpty)
    }

    func testTogglingAPartialFolderSelectsTheRest() {
        let partial: Set<DocGenSource> = [
            .file(url: URL(fileURLWithPath: "/repo/src/a.swift"), name: "a.swift")
        ]
        XCTAssertEqual(DocGenTreeSelection.toggled(node: tree(), selected: partial).count, 3)
    }

    func testTogglingLeavesUnrelatedSelectionsAlone() {
        let other = DocGenSource.file(url: URL(fileURLWithPath: "/elsewhere/x.md"), name: "x.md")
        let result = DocGenTreeSelection.toggled(node: tree(), selected: [other])
        XCTAssertTrue(result.contains(other))
        XCTAssertEqual(result.count, 4)
    }
}
