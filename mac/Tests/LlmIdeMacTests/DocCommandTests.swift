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

    // MARK: - Title line: only the first `# ` line is the title

    func testSecondH1InBodyIsKept() {
        let md = "# Summarize\n\n<!-- llmide:doc-command -->\n\nFirst point.\n# Second heading\nLast point."
        XCTAssertEqual(DocCommand.instruction(from: md),
                       "First point.\n# Second heading\nLast point.")
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "summarize"), "Summarize")
    }

    func testOnlyTheFirstTitleLineIsDropped() {
        let md = "# Title\n# Not a title\n\nBody."
        XCTAssertEqual(DocCommand.instruction(from: md), "# Not a title\n\nBody.")
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "x"), "Title")
    }

    func testFencedShellCommentIsKept() {
        let md = """
        # Install

        Run these steps:

        ```bash
        # install deps
        npm ci
        # run tests
        npm test
        ```
        """
        let instruction = DocCommand.instruction(from: md)
        XCTAssertTrue(instruction.contains("# install deps"), instruction)
        XCTAssertTrue(instruction.contains("# run tests"), instruction)
        XCTAssertFalse(instruction.hasPrefix("# Install"), instruction)
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "install"), "Install")
    }

    func testBodyWithoutAnyHashLineIsUnchanged() {
        let md = "Just a body.\nTwo lines, no heading."
        XCTAssertEqual(DocCommand.instruction(from: md), "Just a body.\nTwo lines, no heading.")
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "just-a-body"), "Just A Body")
    }

    func testCRLFBodyDropsOnlyTheTitleAndKeepsParagraphs() {
        let md = "# Summarize\r\n\r\n<!-- llmide:doc-command -->\r\n\r\nFirst.\r\n# Kept\r\n\r\nLast."
        XCTAssertEqual(DocCommand.instruction(from: md), "First.\n# Kept\n\nLast.")
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "summarize"), "Summarize")
    }

    func testIndentedTitleIsTheSameLineForNameAndInstruction() {
        let md = "   # Indented\n\nBody."
        XCTAssertEqual(DocCommand.displayName(from: md, folderName: "x"), "Indented")
        XCTAssertEqual(DocCommand.instruction(from: md), "Body.")
    }
}
