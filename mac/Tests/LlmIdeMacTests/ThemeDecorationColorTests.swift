import XCTest
import SwiftUI
@testable import LlmIdeMacLib

/// The Explorer tree and the Source Control changes list must never show
/// different colors for the same file. Both go through `Theme`, and this pins
/// the two mappings to each other case by case.
final class ThemeDecorationColorTests: XCTestCase {

    func testDecorationColorsMatchTheFileChangeStatusMappingOnEveryTheme() {
        for theme in Theme.all {
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.modified),
                           theme.color(for: FileChange.Status.modified),
                           "\(theme.id): modified must read as the same color in both panels")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.added),
                           theme.color(for: FileChange.Status.added), "\(theme.id): added")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.untracked),
                           theme.color(for: FileChange.Status.untracked), "\(theme.id): untracked")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.deleted),
                           theme.color(for: FileChange.Status.deleted), "\(theme.id): deleted")
            XCTAssertEqual(theme.color(for: GitTruthStore.Decoration.conflicted),
                           theme.color(for: FileChange.Status.conflicted), "\(theme.id): conflicted")
        }
    }

    /// No raw SwiftUI colors: every decoration color must be one of the
    /// palette's own semantic tokens, so Midnight reads correctly.
    func testEveryDecorationColorIsAPaletteToken() {
        for theme in Theme.all {
            let tokens: Set<Color> = [theme.success, theme.warning, theme.info, theme.danger]
            for decoration in [GitTruthStore.Decoration.modified, .added, .untracked, .deleted, .conflicted] {
                XCTAssertTrue(tokens.contains(theme.color(for: decoration)),
                              "\(theme.id): \(decoration) is not a Theme token")
            }
        }
    }

    func testModifiedIsInfoNotWarning() {
        // Pins the deliberate change away from TreeRowLabel's old hardcoded
        // amber: `modified` is the INFO hue, matching Source Control.
        XCTAssertEqual(Theme.dark.color(for: GitTruthStore.Decoration.modified), Theme.dark.info)
    }
}
