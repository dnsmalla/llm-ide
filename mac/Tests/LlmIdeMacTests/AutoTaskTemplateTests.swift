import XCTest
@testable import LlmIdeMacLib

/// The pure half of Auto Task templates: slugging, and the `---` fenced
/// markdown file format the store reads and writes.
final class AutoTaskTemplateTests: XCTestCase {

    // MARK: - Slugs

    func testSlugLowercasesAndDashesSeparators() {
        XCTAssertEqual(AutoTaskTemplate.slug(for: "Nightly API Review"), "nightly-api-review")
        XCTAssertEqual(AutoTaskTemplate.slug(for: "Review  Code!!"), "review-code")
    }

    /// A name made entirely of punctuation must not yield "" (a zero-length
    /// filename) or a leading dot (a hidden file the scan skips).
    func testSlugFallsBackToUntitledForNonAlphanumericNames() {
        XCTAssertEqual(AutoTaskTemplate.slug(for: "***"), "untitled")
        XCTAssertEqual(AutoTaskTemplate.slug(for: "   "), "untitled")
    }

    func testUniqueSlugAppendsCounterOnCollision() {
        XCTAssertEqual(AutoTaskTemplate.uniqueSlug(base: "review", existing: []), "review")
        XCTAssertEqual(AutoTaskTemplate.uniqueSlug(base: "review", existing: ["review"]), "review-2")
        XCTAssertEqual(AutoTaskTemplate.uniqueSlug(base: "review",
                                                   existing: ["review", "review-2"]), "review-3")
    }

    func testDisplayNameForSlugTitleCasesWords() {
        XCTAssertEqual(AutoTaskTemplate.displayName(forSlug: "nightly-api-review"),
                       "Nightly Api Review")
        XCTAssertEqual(AutoTaskTemplate.displayName(forSlug: "review_code"), "Review Code")
    }

    // MARK: - File format

    func testRenderThenParseRoundTrips() {
        let rendered = AutoTaskTemplate.render(name: "Review Code", body: "Look for bugs.")
        let parsed = AutoTaskTemplate.parse(fileContents: rendered, slug: "review-code")
        XCTAssertEqual(parsed.id, "review-code")
        XCTAssertEqual(parsed.name, "Review Code")
        XCTAssertEqual(parsed.body, "Look for bugs.")
    }

    /// The name is quoted on write precisely so a colon in it cannot be read
    /// back as the end of the key.
    func testNameWithColonAndQuotesRoundTrips() {
        let name = #"Review: "hot" paths"#
        let rendered = AutoTaskTemplate.render(name: name, body: "Body.")
        XCTAssertEqual(AutoTaskTemplate.parse(fileContents: rendered, slug: "x").name, name)
    }

    /// A prompt dropped in by hand (or by another tool) with no header is still
    /// a usable template — dropping it would make the folder look empty.
    func testFileWithoutFrontmatterUsesWholeTextAsBodyAndSlugAsName() {
        let parsed = AutoTaskTemplate.parse(fileContents: "Just a prompt.", slug: "my-prompt")
        XCTAssertEqual(parsed.name, "My Prompt")
        XCTAssertEqual(parsed.body, "Just a prompt.")
    }

    func testUnterminatedFrontmatterIsTreatedAsBody() {
        let text = "---\nname: \"Broken\"\nstill going"
        let parsed = AutoTaskTemplate.parse(fileContents: text, slug: "broken")
        XCTAssertEqual(parsed.name, "Broken")   // slug-derived, not the header
        XCTAssertEqual(parsed.body, text)
    }

    func testHeaderWithoutNameKeyFallsBackToSlug() {
        let text = "---\ndescription: \"no name here\"\n---\n\nBody."
        let parsed = AutoTaskTemplate.parse(fileContents: text, slug: "fallback-name")
        XCTAssertEqual(parsed.name, "Fallback Name")
        XCTAssertEqual(parsed.body, "Body.")
    }

    func testCRLFFileParses() {
        let text = "---\r\nname: \"Windows\"\r\n---\r\n\r\nBody line.\r\n"
        let parsed = AutoTaskTemplate.parse(fileContents: text, slug: "windows")
        XCTAssertEqual(parsed.name, "Windows")
        XCTAssertEqual(parsed.body, "Body line.")
    }

    /// `render` ends the file with a newline; `parse` must strip it, or the
    /// editor would compare a just-saved draft against a body one newline
    /// longer and show "Unsaved" forever.
    func testParsedBodyHasNoTrailingNewline() {
        let rendered = AutoTaskTemplate.render(name: "N", body: "Body.")
        XCTAssertEqual(AutoTaskTemplate.parse(fileContents: rendered, slug: "n").body, "Body.")
    }

    func testRenderIsAFixedPointOverParse() {
        let once = AutoTaskTemplate.render(name: "N", body: "Body.")
        let parsed = AutoTaskTemplate.parse(fileContents: once, slug: "n")
        XCTAssertEqual(AutoTaskTemplate.render(name: parsed.name, body: parsed.body), once)
    }

    func testUnquotedNameValueIsAccepted() {
        let text = "---\nname: Plain Name\n---\n\nBody."
        XCTAssertEqual(AutoTaskTemplate.parse(fileContents: text, slug: "x").name, "Plain Name")
    }
}
