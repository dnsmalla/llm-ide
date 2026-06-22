import XCTest
import GraphKit
@testable import LlmIdeMac

/// "md is doc": markdown must be routed to the InfiniteBrain/doc track only,
/// not the code track. These pin (1) the extension classification and (2) the
/// helper that strips code-track markdown (`.docPage` nodes + their heading
/// symbols) out of a code graph, so a markdown file is represented once (as a
/// doc), not duplicated in "All".
final class FileClassifierTests: XCTestCase {

    func testMarkdownAndTextClassifyAsDoc() {
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/README.md")), .doc)
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/Notes.markdown")), .doc)
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/spec.mdx")), .doc)
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/log.txt")), .doc)
    }

    func testSourceFilesClassifyAsCode() {
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/App.swift")), .code)
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/a.ts")), .code)
        XCTAssertEqual(FileClassifier.kind(of: URL(fileURLWithPath: "/x/a.py")), .code)
    }

    func testMarkdownIsNotInTheCodeExtensionSet() {
        // The GraphKit scanner's set includes "md"; FileClassifier must exclude
        // anything we treat as a doc so its code-first `kind()` can't misroute it.
        XCTAssertFalse(FileClassifier.codeExtensions.contains("md"))
        XCTAssertTrue(FileClassifier.docExtensions.contains("md"))
    }

    func testStrippingDocNodesRemovesMarkdownFileAndItsHeadings() {
        // A code graph as GraphKit emits it: a markdown file (.docPage) with a
        // heading symbol it `.contains`, plus a real source file + symbol.
        let docPage = CGNode(id: "doc.md", title: "Doc", kind: .docPage)
        let heading = CGNode(id: "doc.md#h", title: "Heading", kind: .function)
        let srcFile = CGNode(id: "a.swift", title: "a.swift", kind: .file)
        let srcSym  = CGNode(id: "a.swift#f", title: "f()", kind: .function)
        let graph = CGData(
            nodes: [docPage, heading, srcFile, srcSym],
            edges: [
                CGEdge(fromId: "doc.md", toId: "doc.md#h", kind: .contains),
                CGEdge(fromId: "a.swift", toId: "a.swift#f", kind: .contains),
            ])

        let stripped = FileClassifier.strippingDocNodes(from: graph)
        let ids = Set(stripped.nodes.map(\.id))

        XCTAssertFalse(ids.contains("doc.md"), "markdown file node should be stripped")
        XCTAssertFalse(ids.contains("doc.md#h"), "markdown heading symbol should be stripped")
        XCTAssertTrue(ids.contains("a.swift"), "real source file must remain")
        XCTAssertTrue(ids.contains("a.swift#f"), "real source symbol must remain")
        XCTAssertTrue(stripped.edges.allSatisfy { ids.contains($0.fromId) && ids.contains($0.toId) },
                      "no edge may dangle to a stripped node")
    }

    func testStrippingDocNodesIsANoOpWhenNoMarkdown() {
        let srcFile = CGNode(id: "a.swift", title: "a.swift", kind: .file)
        let graph = CGData(nodes: [srcFile], edges: [])
        XCTAssertEqual(FileClassifier.strippingDocNodes(from: graph).nodes.count, 1)
    }
}
