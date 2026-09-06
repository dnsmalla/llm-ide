import XCTest
@testable import LlmIdeMac

final class GenerationTreeSelectionTests: XCTestCase {

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
            GenerationTreeSelection.fileLeaves(of: tree()).map(\.path).sorted(),
            ["/repo/README.md", "/repo/src/a.swift", "/repo/src/b.swift"])
    }

    func testStateIsNoneWhenNothingSelected() {
        XCTAssertEqual(GenerationTreeSelection.state(for: tree(), selected: []), .none)
    }

    func testStateIsPartialWithSomeSelected() {
        let selected: Set<DocGenSource> = [
            .file(url: URL(fileURLWithPath: "/repo/src/a.swift"), name: "a.swift")
        ]
        XCTAssertEqual(GenerationTreeSelection.state(for: tree(), selected: selected), .partial)
    }

    func testStateIsAllWhenEveryLeafSelected() {
        let selected = Set(GenerationTreeSelection.fileLeaves(of: tree()).map {
            DocGenSource.file(url: $0.url, name: $0.name)
        })
        XCTAssertEqual(GenerationTreeSelection.state(for: tree(), selected: selected), .all)
    }

    func testTogglingAFolderSelectsEveryLeafBeneathIt() {
        let result = GenerationTreeSelection.toggled(node: tree(), selected: [])
        XCTAssertEqual(result.count, 3)
    }

    func testTogglingAFullySelectedFolderClearsIt() {
        let full = GenerationTreeSelection.toggled(node: tree(), selected: [])
        XCTAssertTrue(GenerationTreeSelection.toggled(node: tree(), selected: full).isEmpty)
    }

    func testTogglingAPartialFolderSelectsTheRest() {
        let partial: Set<DocGenSource> = [
            .file(url: URL(fileURLWithPath: "/repo/src/a.swift"), name: "a.swift")
        ]
        XCTAssertEqual(GenerationTreeSelection.toggled(node: tree(), selected: partial).count, 3)
    }

    func testTogglingLeavesUnrelatedSelectionsAlone() {
        let other = DocGenSource.file(url: URL(fileURLWithPath: "/elsewhere/x.md"), name: "x.md")
        let result = GenerationTreeSelection.toggled(node: tree(), selected: [other])
        XCTAssertTrue(result.contains(other))
        XCTAssertEqual(result.count, 4)
    }

    // MARK: - states(forForest:) — rows read this, not state(for:), so it needs
    // its own coverage (see GenerationTreeSelection.states doc comment).

    /// Adds, versus `tree()`: a nested folder-of-folders with NO file leaves
    /// anywhere beneath it (`empty-parent/empty-child/`), to exercise the
    /// vacuous 0-of-0 case at two folder depths.
    private func mixedTree() -> FSNode {
        folder("/repo", [
            folder("/repo/src", [file("/repo/src/a.swift"), file("/repo/src/b.swift")]),
            folder("/repo/empty-parent", [folder("/repo/empty-parent/empty-child", [])]),
            file("/repo/README.md"),
        ])
    }

    private func allNodes(_ node: FSNode) -> [FSNode] {
        [node] + node.children.flatMap(allNodes)
    }

    func testStatesForForestIsPartialAtEveryAncestorOfAMixedSelection() {
        let selected: Set<DocGenSource> = [
            .file(url: URL(fileURLWithPath: "/repo/src/a.swift"), name: "a.swift"),
            .file(url: URL(fileURLWithPath: "/repo/README.md"), name: "README.md"),
        ]
        let states = GenerationTreeSelection.states(forForest: [mixedTree()], selected: selected)

        XCTAssertEqual(states["/repo"], .partial)
        XCTAssertEqual(states["/repo/src"], .partial)
        XCTAssertEqual(states["/repo/src/a.swift"], .all)
        XCTAssertEqual(states["/repo/src/b.swift"], .none)
        XCTAssertEqual(states["/repo/README.md"], .all)
    }

    func testStatesForForestFolderWithZeroFileLeavesIsNeverAll() {
        let tree = mixedTree()

        // Even when every actual file leaf in the forest is selected, a
        // folder whose subtree has ZERO file leaves must still read as
        // `.none` — a vacuous 0-of-0 comparison (hits == total when
        // total == 0) must never be mistaken for "fully selected".
        let everyLeaf = Set(GenerationTreeSelection.fileLeaves(of: tree).map {
            DocGenSource.file(url: $0.url, name: $0.name)
        })
        let states = GenerationTreeSelection.states(forForest: [tree], selected: everyLeaf)

        XCTAssertEqual(states["/repo"], .all)
        XCTAssertEqual(states["/repo/empty-parent"], .none)
        XCTAssertEqual(states["/repo/empty-parent/empty-child"], .none)
    }

    func testStatesForForestAgreesWithPerNodeStateForEveryNode() {
        let tree = mixedTree()
        let selected: Set<DocGenSource> = [
            .file(url: URL(fileURLWithPath: "/repo/src/a.swift"), name: "a.swift")
        ]
        let states = GenerationTreeSelection.states(forForest: [tree], selected: selected)

        for node in allNodes(tree) {
            XCTAssertEqual(
                states[node.id],
                GenerationTreeSelection.state(for: node, selected: selected),
                "states(forForest:) disagrees with state(for:) at \(node.id)")
        }
    }
}
