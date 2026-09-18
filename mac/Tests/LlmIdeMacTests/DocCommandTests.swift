import XCTest
@testable import LlmIdeMacLib

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

    func testSeedIDsAreUsedForSeedFolders() throws {
        // `seedDefinitions` is `[]` since the shipped defaults moved to the
        // server-supplied kit, which makes `stableID`'s pinning branch
        // unreachable for now. SKIP rather than subscript: `[0]` on the empty
        // array trapped with "Index out of range" and killed the whole XCTest
        // process, so every suite ordered after this one silently never ran.
        // The assertion still stands if pinned seeds ever come back.
        try XCTSkipIf(DocCommand.seedDefinitions.isEmpty,
                      "no seed definitions — stableID's pinning branch is unreachable")
        let seed = try XCTUnwrap(DocCommand.seedDefinitions.first)
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
