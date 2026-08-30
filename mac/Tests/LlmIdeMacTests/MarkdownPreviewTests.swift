import Testing
import Foundation
@testable import LlmIdeMacLib

/// The collapsed-reply preview shared by both transcripts.
@Suite("Markdown plain-text preview")
struct MarkdownPreviewTests {

    @Test("Structural markdown is stripped, inline hyphens survive")
    func stripsMarkup() {
        let out = MarkdownRenderer.plainTextPreview(
            "## Title\n\nSome **bold** and `code` and a well-known hyphen.")
        #expect(out == "Title Some bold and code and a well-known hyphen.")
    }

    @Test("Links keep their text and drop the URL")
    func linksBecomeText() {
        #expect(MarkdownRenderer.plainTextPreview("See [the docs](https://example.com/x) now")
                == "See the docs now")
    }

    @Test("Long replies are clipped with an ellipsis")
    func clipsToLimit() {
        let out = MarkdownRenderer.plainTextPreview(String(repeating: "a", count: 400))
        #expect(out.count == 161)          // 160 + the ellipsis
        #expect(out.hasSuffix("…"))
    }

    @Test("Short replies are returned whole, with no ellipsis")
    func shortRepliesUnchanged() {
        #expect(MarkdownRenderer.plainTextPreview("brief answer") == "brief answer")
    }
}
