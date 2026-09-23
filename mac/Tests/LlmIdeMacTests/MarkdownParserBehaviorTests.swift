import Testing
import Foundation
import JavaScriptCore
@testable import LlmIdeMacLib

/// Runs the renderer's REAL `parseMarkdown` (the script embedded in
/// `MarkdownRenderer.html`) under JavaScriptCore, so its output can be
/// asserted rather than only the document text around it. The escaping
/// suite next door never executes the parser — which is how the numbered-list
/// and inline-code bugs below shipped.
@Suite("Markdown parser behavior")
struct MarkdownParserBehaviorTests {
    /// The document's parser script, evaluated with just enough DOM stubbed
    /// for its top-level statements to run.
    private func parse(_ markdown: String) throws -> String {
        let html = MarkdownRenderer.html(for: "x", isDark: false)
        let script = try #require(
            html.components(separatedBy: "<script>").first { $0.contains("function parseMarkdown") }?
                .components(separatedBy: "</script>").first)
        let ctx = try #require(JSContext())
        ctx.evaluateScript("""
            var window = this;
            var document = {
              body: { scrollHeight: 0 },
              getElementById: function() { return { innerHTML: '' }; },
              querySelectorAll: function() { return []; },
              createElement: function() { return {}; }
            };
            """)
        ctx.evaluateScript(script)
        let fn = try #require(ctx.objectForKeyedSubscript("parseMarkdown"))
        return try #require(fn.call(withArguments: [markdown])?.toString())
    }

    @Test("Numbered items spaced by blank lines are ONE <ol>, with no empty paragraphs")
    func numberedListWraps() throws {
        // Regression (F9): items became bare <li> after the <ul> wrap, so each
        // one was split out of its <p> and left empty paragraphs — the same
        // dead space cf564532 fixed for bullets — and the numbers were lost.
        let out = try parse("Steps:\n\n1. a\n\n2. b\n\nDone")
        #expect(out == "<p>Steps:</p><ol><li>a</li><li>b</li></ol><p>Done</p>", "got: \(out)")
    }

    @Test("A continued numbered list keeps its starting number")
    func numberedListStart() throws {
        #expect(try parse("3. c\n4. d").contains("<ol start=\"3\">"))
    }

    @Test("Bullets still become <ul>")
    func bulletsUnchanged() throws {
        let out = try parse("- a\n\n- b")
        #expect(out.contains("<ul><li>a</li>"))
        #expect(!out.contains("<ol"))
    }

    @Test("Inline code is not touched by emphasis")
    func inlineCodeProtected() throws {
        // Regression: emphasis ran before inline code was lifted out.
        let out = try parse("Call `__init__` or `a*b*c`.")
        #expect(out.contains("<code>__init__</code>"))
        #expect(out.contains("<code>a*b*c</code>"))
        #expect(!out.contains("<strong>init"))
    }

    @Test("Inline code inside a link URL cannot break out of href")
    func inlineCodeInHrefIsEscaped() throws {
        // Regression (pre-merge review): the inline-code placeholder hid the
        // `"` from escQuotes, and restoring it as markup put a raw quote
        // inside href="…" — a live onmouseover from model output.
        let out = try parse("[a](http://x/`\" onmouseover=\"alert(1)//`)")
        #expect(!out.contains("\" onmouseover"), "got: \(out)")
        #expect(!out.contains("href=\"http://x/<code>"))
        #expect(out.contains("&quot;"))
    }

    @Test("Intraword underscores stay literal; real _emphasis_ still works")
    func underscoreEmphasis() throws {
        let out = try parse("use my_var_name and _this_ now")
        #expect(out.contains("my_var_name"))
        #expect(out.contains("<em>this</em>"))
    }
}
