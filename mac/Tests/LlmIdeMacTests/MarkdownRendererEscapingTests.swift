import Testing
import Foundation
@testable import LlmIdeMacLib

/// `MarkdownRenderer.html` builds a self-contained document whose content is
/// spliced into a JavaScript template literal. These tests pin the escaping
/// rules for that splice, and the payload-size rule that keeps a streaming
/// bubble cheap to render.
///
/// They assert on the generated HTML rather than on rendered output because
/// the renderer is a pure String -> String function; the failures they guard
/// against are all visible right there in the document text.
@Suite("MarkdownRenderer document")
struct MarkdownRendererEscapingTests {

    @Test("A reply containing </script> cannot terminate the script block")
    func closingScriptTagIsNeutralized() {
        // HTML's script-data state ends at the first literal `</script`,
        // regardless of the JavaScript string it sits inside — so before this
        // was escaped, any reply CONTAINING that text (routine for a coding
        // assistant discussing HTML) cut the document in half and the bubble
        // rendered as garbage.
        let html = MarkdownRenderer.html(for: "Use `</script>` to close it.", isDark: false)

        // The raw sequence must not appear inside the content assignment.
        let contentLine = html.components(separatedBy: "\n")
            .first { $0.hasPrefix("const raw = ") }
        #expect(contentLine != nil)
        #expect(contentLine?.contains("</script>") == false)
        // `<\/` is an identity escape in JS, so the VALUE is unchanged.
        #expect(contentLine?.contains("<\\/script>") == true)
    }

    @Test("Backticks and template interpolation in a reply can't break out of the literal")
    func templateLiteralEscapes() {
        let html = MarkdownRenderer.html(for: "a ` b ${c} d \\ e", isDark: false)
        let contentLine = html.components(separatedBy: "\n")
            .first { $0.hasPrefix("const raw = ") }
        #expect(contentLine?.contains("\\`") == true)
        #expect(contentLine?.contains("\\${c}") == true)
        #expect(contentLine?.contains("\\\\") == true)
    }

    @Test("The in-place render hook is exposed for streaming re-renders")
    func exposesRenderHook() {
        // SelfSizingMarkdownView calls this instead of reloading the document
        // on every streamed chunk. If it stops being exported, the view falls
        // back to full reloads and the streaming cost regression returns
        // silently — so pin the contract here.
        let html = MarkdownRenderer.html(for: "hi", isDark: false)
        #expect(html.contains("window.__renderMarkdown = renderMarkdown;"))
        #expect(html.contains("return document.body.scrollHeight;"))
    }

    @Test("The syntax highlighter ships only when there is a code fence")
    func highlighterIsConditional() {
        // Hljs.js is ~122 KB the web view parses and evaluates on every
        // document load. Most replies are prose.
        #expect(MarkdownRenderer.needsHighlighting("just prose, no fences") == false)
        #expect(MarkdownRenderer.needsHighlighting("text\n```swift\nlet x = 1\n```") == true)

        // The size half of the claim can only be checked where the vendored
        // asset actually resolves. `Hljs` reads it from `Bundle.main`, which
        // under `swift test` is the test runner, not the app — so it comes
        // back empty here and both documents are the same size. Assert the
        // saving only when there is something to save, rather than pretending
        // this environment can see it.
        guard !Hljs.js.isEmpty else { return }
        let prose = MarkdownRenderer.html(for: "just prose", isDark: false)
        let withCode = MarkdownRenderer.html(for: "```swift\nlet x = 1\n```", isDark: false)
        #expect(withCode.count - prose.count > 100_000)
    }

    @Test("Theme choice still reaches the document")
    func themeIsApplied() {
        #expect(MarkdownRenderer.html(for: "x", isDark: true).contains("content=\"dark\""))
        #expect(MarkdownRenderer.html(for: "x", isDark: false).contains("content=\"light\""))
    }
}
