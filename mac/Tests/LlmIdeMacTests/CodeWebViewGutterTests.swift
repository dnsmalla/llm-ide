import XCTest
@testable import LlmIdeMacLib

/// The file viewer draws line numbers and code as two INDEPENDENT stacks of
/// line boxes in a CSS grid. Nothing ties row N of the gutter to row N of the
/// code — they line up only while both stacks use exactly the same row height.
/// Every assertion here pins one half of that contract, because the failure is
/// gradual and easy to reintroduce: a fractional per-row difference looks fine
/// at the top of the file and is a full line off by line 30.
final class CodeWebViewGutterTests: XCTestCase {

    private func html(_ code: String, language: String = "swift") -> String {
        CodeWebView(code: code, language: language, isDark: true).html()
    }

    // MARK: - Row height

    func testRowHeightIsAbsoluteNotAMultiplier() {
        let out = html("let a = 1\nlet b = 2\n")
        // A unitless line-height resolves against each element's OWN font-size,
        // so any font-size difference between the columns compounds per row.
        XCTAssertTrue(out.contains("--row: 20px"),
                      "row height must be an absolute length shared by both columns")
        XCTAssertTrue(out.contains("line-height: var(--row)"),
                      "body must adopt the absolute row height")
        XCTAssertFalse(out.contains("line-height: 1.6"),
                       "the unitless multiplier is the drift bug — it must not come back")
    }

    func testLineNumberRowsArePinnedToTheSameRowHeight() {
        let out = html("x\ny\n")
        XCTAssertTrue(out.contains(".ln, .row { display: block; height: var(--row); }"),
                      "a number's box must be exactly as tall as its code line")
    }

    // MARK: - Font inheritance

    func testNestedPreAndCodeInheritTheColumnFont() {
        let out = html("let a = 1\n")
        // `pre`/`code` carry a UA `font-family: monospace`, which in WebKit also
        // switches them to the default FIXED font size (13px) instead of the
        // body's 12.5px. Styling only the column divs leaves that mismatch in
        // place — this selector is the actual fix.
        XCTAssertTrue(out.contains(".ln-col, .code-col, .code-col pre, .code-col code {"),
                      "pre and code must be in the font-inheriting rule, not just the column divs")
        guard let ruleStart = out.range(of: ".ln-col, .code-col, .code-col pre, .code-col code {"),
              let ruleEnd = out.range(of: "}", range: ruleStart.upperBound..<out.endIndex) else {
            return XCTFail("could not isolate the shared column rule")
        }
        let rule = String(out[ruleStart.upperBound..<ruleEnd.lowerBound])
        XCTAssertTrue(rule.contains("font: inherit"), "font must be inherited, not UA-defaulted")
        XCTAssertTrue(rule.contains("line-height: inherit"), "row height must be inherited too")
    }

    // MARK: - Gutter construction

    func testGutterSpansAreNotSeparatedByNewlines() {
        let out = html("a\nb\nc\n")
        // `.ln-col` is `white-space: pre`, where a newline is NOT collapsible.
        // Between two block-level spans it becomes an anonymous block and
        // renders as its own empty row — double-pitching the whole gutter.
        XCTAssertTrue(out.contains("'</span>';"),
                      "line-number spans must be concatenated with no separator")
        XCTAssertFalse(out.contains("</span>\\n'"),
                       "a newline between gutter spans adds a phantom row per line")
    }

    func testTrailingNewlineDoesNotProduceAPhantomNumber() {
        let out = html("a\nb\n")
        // The JS drops a final empty element from the split; keep that guard.
        XCTAssertTrue(out.contains("lines.pop()"),
                      "a file's trailing newline must not add an extra gutter number")
    }

    // MARK: - Change bars

    func testChangeBarsDoNotShiftRowsHorizontally() {
        let out = CodeWebView(code: "a\nb\n", language: "swift", isDark: true,
                              changedLines: [2: .added]).html()
        XCTAssertTrue(out.contains("2:\"g-add\""), "the change map must reach the page")
        // A border only on marked rows would indent them relative to the rest.
        XCTAssertTrue(out.contains(".ln { border-left: 3px solid transparent; }"),
                      "every row needs the same baseline border so marks don't shift text")
    }
}
