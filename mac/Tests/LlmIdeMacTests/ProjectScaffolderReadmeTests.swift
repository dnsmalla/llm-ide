import XCTest
@testable import LlmIdeMacLib

final class ProjectScaffolderReadmeTests: XCTestCase {
    private let generated = "# Name\n\n<!-- llmide:auto — refreshed -->\n\n## Project Info\nNEW\n"

    func testNotesAboveMarkerSurviveRefresh() {
        let existing = "# Mine\n\nMy own notes.\n\n<!-- llmide:auto — old -->\n\nOLD\n"
        let merged = ProjectScaffolder.mergedReadme(existing: existing, generated: generated)
        XCTAssertEqual(merged, "# Mine\n\nMy own notes.\n\n<!-- llmide:auto — refreshed -->\n\n## Project Info\nNEW\n")
    }

    func testLegacyMarkerIsUpgradedAndNotesKept() {
        let existing = "notes\n<!-- meetnotes:auto -->\nOLD\n"
        let merged = ProjectScaffolder.mergedReadme(existing: existing, generated: generated)
        XCTAssertTrue(merged?.hasPrefix("notes\n<!-- llmide:auto") == true)
        XCTAssertFalse(merged?.contains("OLD") == true)
    }

    func testReadmeWithoutMarkerIsLeftAlone() {
        XCTAssertNil(ProjectScaffolder.mergedReadme(existing: "# Repo README\n", generated: generated))
    }

    func testInlineMarkerMentionDoesNotTruncate() {
        let existing = "Notes mention `<!-- llmide:auto` inline.\n\n<!-- llmide:auto — old -->\nOLD\n"
        let merged = ProjectScaffolder.mergedReadme(existing: existing, generated: generated)
        XCTAssertTrue(merged?.hasPrefix("Notes mention `<!-- llmide:auto` inline.\n\n<!-- llmide:auto — refreshed") == true)
    }

    func testOnlyInlineMarkerIsForeign() {
        XCTAssertNil(ProjectScaffolder.mergedReadme(existing: "see `<!-- llmide:auto` here\n", generated: generated))
    }
}
