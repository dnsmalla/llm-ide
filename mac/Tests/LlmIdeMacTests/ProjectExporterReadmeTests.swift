import XCTest
@testable import LlmIdeMacLib

/// The export's "Last exported" stamp must only touch LLM-IDE-managed READMEs.
@MainActor
final class ProjectExporterReadmeTests: XCTestCase {

    private func tempReadme(_ text: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("exporter-readme-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("README.md")
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    func testForeignReadmeIsLeftUntouched() throws {
        let original = "# Cloned repo\n\nTheir docs.\n"
        let url = try tempReadme(original)
        ProjectExporter().updateReadme(at: url, meetings: 3)
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), original)
    }

    func testManagedReadmeGetsStamped() throws {
        let url = try tempReadme("# Mine\n\n<!-- llmide:auto — x -->\n\n## Info\n")
        ProjectExporter().updateReadme(at: url, meetings: 3)
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("**Last exported:**"))
        XCTAssertTrue(text.contains("3 meeting(s)"))
    }
}
