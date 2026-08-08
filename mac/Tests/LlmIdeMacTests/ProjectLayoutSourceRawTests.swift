import XCTest
@testable import LlmIdeMacLib

final class ProjectLayoutSourceRawTests: XCTestCase {
    func testSourceRawDirUsesDirectoryName() {
        let root = URL(fileURLWithPath: "/tmp/llmide-proj")
        let layout = ProjectLayout(root: root)
        XCTAssertEqual(layout.sourceRawDir(for: .meeting).path,   "/tmp/llmide-proj/source/meetings")
        XCTAssertEqual(layout.sourceRawDir(for: .email).path,     "/tmp/llmide-proj/source/emails")
        XCTAssertEqual(layout.sourceRawDir(for: .document).path,  "/tmp/llmide-proj/source/documents")
        XCTAssertEqual(layout.sourceRawDir(for: NoteType("slack")).path, "/tmp/llmide-proj/source/slack")
    }

    func testSourceRawDirSymmetricWithNotesDir() {
        let root = URL(fileURLWithPath: "/tmp/llmide-proj")
        let layout = ProjectLayout(root: root)
        // raw and processed share the <type.directoryName> segment.
        let type = NoteType("slack")
        XCTAssertEqual(layout.sourceRawDir(for: type).lastPathComponent,
                       layout.notesDir.appendingPathComponent(type.directoryName).lastPathComponent)
    }
}
