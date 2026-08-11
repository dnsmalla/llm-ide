import XCTest
@testable import LlmIdeMacLib

/// The Graph & Memory settings card reports node counts parsed out of the
/// memory artifact. Two different files carry them in two different shapes,
/// and the card previously only understood the rarer one — so the counts were
/// blank on exactly the repos that HAD a generated graph.
final class GraphMemoryStateCountsTests: XCTestCase {

    func testParsesGraphNotesShapeWithNumberAfterLabel() {
        let body = """
        # Graph notes

        - Code nodes: 128
        - Doc nodes: 12
        - Edges: 340

        ## Doc → code references
        """
        let counts = GraphMemoryState.parseCounts(body)
        XCTAssertEqual(counts?.code, 128)
        XCTAssertEqual(counts?.doc, 12)
        XCTAssertEqual(counts?.edges, 340)
    }

    func testParsesRepoFallbackShapeWithNumberBeforeLabel() {
        let body = "# Repository knowledge graph\n\n7 code nodes · 3 doc nodes · 19 edges.\n"
        let counts = GraphMemoryState.parseCounts(body)
        XCTAssertEqual(counts?.code, 7)
        XCTAssertEqual(counts?.doc, 3)
        XCTAssertEqual(counts?.edges, 19)
    }

    /// repo.md is normally a verbatim copy of the code graph's index.md, which
    /// carries no node counts — that must read as "unknown", not as zero.
    func testCodebaseIndexYieldsNoCounts() {
        let body = """
        # Codebase Index

        | Field | Value |
        |-------|-------|
        | **Files** | 42 |

        ## High-Impact Files
        """
        XCTAssertNil(GraphMemoryState.parseCounts(body))
    }

    /// "knowledge" contains "edge" — the header must not be mistaken for the
    /// edge count (it was, and the card read 0 edges for every such repo).
    func testHeaderWordKnowledgeIsNotReadAsAnEdgeCount() {
        let body = "# Repository knowledge graph\n\n7 code nodes · 3 doc nodes · 19 edges.\n"
        XCTAssertEqual(GraphMemoryState.parseCounts(body)?.edges, 19)
    }

    func testEdgesDefaultToZeroWhenAbsent() {
        let counts = GraphMemoryState.parseCounts("- Code nodes: 5\n- Doc nodes: 1\n")
        XCTAssertEqual(counts?.code, 5)
        XCTAssertEqual(counts?.edges, 0)
    }
}
