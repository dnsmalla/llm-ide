import XCTest
@testable import LlmIdeMacLib

final class ThemeGitTokensTests: XCTestCase {
    func testDiffTokensDeriveFromExistingSemanticAliases() {
        for theme in Theme.all {
            XCTAssertEqual(theme.diffAddedFg, theme.success, "\(theme.id): added must track success")
            XCTAssertEqual(theme.diffDeletedFg, theme.danger, "\(theme.id): deleted must track danger")
            XCTAssertEqual(theme.gutterAddedMark, theme.success, "\(theme.id): gutter added must track success")
            XCTAssertEqual(theme.gutterModifiedMark, theme.info, "\(theme.id): gutter modified must track info")
            XCTAssertEqual(theme.gutterDeletedMark, theme.danger, "\(theme.id): gutter deleted must track danger")
        }
    }

    func testEditorBaseTokensTrackBodyAndMutedText() {
        for theme in Theme.all {
            XCTAssertEqual(theme.editorBackground, theme.body, "\(theme.id): editor background must track body")
            XCTAssertEqual(theme.editorLineNumber, theme.textMuted, "\(theme.id): line numbers must track textMuted")
        }
    }

    func testColorForStatusUsesThemeTokensNotRawColors() {
        let t = Theme.dark
        XCTAssertEqual(t.color(for: .added), t.success)
        XCTAssertEqual(t.color(for: .untracked), t.success)
        XCTAssertEqual(t.color(for: .deleted), t.danger)
        XCTAssertEqual(t.color(for: .conflicted), t.warning)
        XCTAssertEqual(t.color(for: .modified), t.accent2)
        XCTAssertEqual(t.color(for: .renamed), t.accent2)
    }
}
