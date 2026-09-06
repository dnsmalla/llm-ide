import XCTest
@testable import LlmIdeMac

final class DocCommandTests: XCTestCase {

    func testInstructionStripsTitleAndMarker() {
        let md = """
        # Summarize

        <!-- llmide:doc-command -->

        Summarize the selected sources in five bullets.
        Keep it terse.
        """
        XCTAssertEqual(
            DocCommand.instruction(from: md),
            "Summarize the selected sources in five bullets.\nKeep it terse.")
    }

    func testDisplayNameFallsBackToHumanizedFolder() {
        XCTAssertEqual(
            DocCommand.displayName(from: "no heading here", folderName: "release-notes"),
            "Release Notes")
    }

    func testDisplayNamePrefersHeading() {
        XCTAssertEqual(
            DocCommand.displayName(from: "# Explain Code\n\nbody", folderName: "explain-code"),
            "Explain Code")
    }

    func testStableIDIsStableAndDistinctFromTemplates() {
        let a = DocCommand.stableID(forFolder: "my-command")
        let b = DocCommand.stableID(forFolder: "my-command")
        XCTAssertEqual(a, b)
        // Different namespace than DocTemplate — same folder name must not collide.
        XCTAssertNotEqual(a, DocTemplate.stableID(forFolder: "my-command"))
    }

    func testSeedIDsAreUsedForSeedFolders() {
        let seed = DocCommand.seedDefinitions[0]
        XCTAssertEqual(DocCommand.stableID(forFolder: seed.folderName), seed.id)
    }

    func testMarkdownBodyRoundTrips() {
        let md = DocCommand.markdownBody(name: "Terse", instruction: "Be brief.")
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "terse"), "Terse")
        XCTAssertEqual(DocCommand.instruction(from: md), "Be brief.")
    }

    func testSlugSanitizes() {
        XCTAssertEqual(DocCommand.slug(for: "Release  Notes!"), "release-notes")
    }
}
