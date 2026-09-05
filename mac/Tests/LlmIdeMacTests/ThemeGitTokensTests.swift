import XCTest
import SwiftUI
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

    // `color(for:)` is overloaded for FileChange.Status and
    // GitTruthStore.Decoration, and the two enums share member names, so an
    // implicit `.added` is ambiguous — spell the type out.
    func testColorForStatusUsesThemeTokensNotRawColors() {
        let t = Theme.dark
        XCTAssertEqual(t.color(for: FileChange.Status.added), t.success)
        XCTAssertEqual(t.color(for: FileChange.Status.untracked), t.success)
        XCTAssertEqual(t.color(for: FileChange.Status.deleted), t.danger)
        XCTAssertEqual(t.color(for: FileChange.Status.conflicted), t.warning)
        XCTAssertEqual(t.color(for: FileChange.Status.modified), t.accent2)
        XCTAssertEqual(t.color(for: FileChange.Status.renamed), t.accent2)
    }

    func testColorForDecorationUsesThemeTokensNotRawColors() {
        let t = Theme.dark
        XCTAssertEqual(t.color(for: GitTruthStore.Decoration.added), t.success)
        XCTAssertEqual(t.color(for: GitTruthStore.Decoration.untracked), t.success)
        XCTAssertEqual(t.color(for: GitTruthStore.Decoration.deleted), t.danger)
        XCTAssertEqual(t.color(for: GitTruthStore.Decoration.conflicted), t.warning)
        XCTAssertEqual(t.color(for: GitTruthStore.Decoration.modified), t.info)
    }

    func testHexRGBFormatsAsUppercaseSixDigitHex() {
        XCTAssertEqual(Color.white.hexRGB(), "#FFFFFF")
        XCTAssertEqual(Color.black.hexRGB(), "#000000")
    }

    func testMonacoThemeBaseMatchesIsDark() {
        XCTAssertEqual(Theme.dark.monacoTheme().base, "vs-dark")
        XCTAssertEqual(Theme.midnight.monacoTheme().base, "vs-dark")
        XCTAssertEqual(Theme.light.monacoTheme().base, "vs")
    }

    func testMonacoThemeColorsMatchThemeTokens() {
        let t = Theme.dark
        let m = t.monacoTheme()
        XCTAssertEqual(m.colors["editor.background"], t.editorBackground.hexRGB())
        XCTAssertEqual(m.colors["editor.foreground"], t.text.hexRGB())
        XCTAssertEqual(m.colors["editorLineNumber.foreground"], t.editorLineNumber.hexRGB())
        XCTAssertTrue(m.inherit)
    }

    func testMonacoThemeJSONIsValidJSONWithExpectedKeys() throws {
        let json = Theme.dark.monacoThemeJSON()
        let data = try XCTUnwrap(json.data(using: .utf8))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["base"] as? String, "vs-dark")
        XCTAssertNotNil(obj["colors"] as? [String: String])
    }
}
