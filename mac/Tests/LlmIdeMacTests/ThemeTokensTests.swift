import AppKit
import SwiftUI
import XCTest
@testable import LlmIdeMacLib

/// Pins `Theme` to the values it had before the palette moved into
/// schema/design/tokens.json. The expected numbers below were copied from the
/// original hand-written `Theme.swift`, so a drift in the token file (or in the
/// mapping from `ThemeTokens` to `Theme`) fails here instead of shipping a
/// different look.
final class ThemeTokensTests: XCTestCase {
    /// sRGB components of a SwiftUI colour, for exact comparison.
    private func rgba(_ c: Color, file: StaticString = #filePath, line: UInt = #line) -> [CGFloat] {
        guard let ns = NSColor(c).usingColorSpace(.deviceRGB) else {
            XCTFail("colour has no sRGB form", file: file, line: line)
            return []
        }
        return [ns.redComponent, ns.greenComponent, ns.blueComponent, ns.alphaComponent]
    }

    private func assertColor(
        _ actual: Color,
        _ expected: (Double, Double, Double, Double),
        _ name: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let got = rgba(actual, file: file, line: line)
        guard got.count == 4 else { return }
        let want = [expected.0, expected.1, expected.2, expected.3].map { CGFloat($0) }
        for i in 0..<4 {
            XCTAssertEqual(got[i], want[i], accuracy: 0.0005, "\(name) component \(i)", file: file, line: line)
        }
    }

    // MARK: - Theme list

    func test_themeListOrderAndIdentity() {
        XCTAssertEqual(Theme.all.map(\.id), ["dark", "light", "midnight"])
        XCTAssertEqual(Theme.all.map(\.name), ["Dark", "Light", "Midnight"])
        XCTAssertEqual(Theme.all.map(\.isDark), [true, false, true])
        XCTAssertEqual(Theme.find(id: "midnight").id, "midnight")
        XCTAssertEqual(Theme.find(id: "no-such-theme").id, "dark")
    }

    // MARK: - Dark

    func test_darkRoles() {
        let t = Theme.dark
        assertColor(t.body, (0.07, 0.08, 0.11, 1), "dark.body")
        assertColor(t.surface, (0.14, 0.15, 0.20, 1), "dark.surface")
        assertColor(t.surface2, (0.19, 0.20, 0.26, 1), "dark.surface2")
        assertColor(t.border, (1, 1, 1, 0.14), "dark.border")
        assertColor(t.text, (0.94, 0.95, 0.98, 1), "dark.text")
        assertColor(t.textMuted, (0.78, 0.81, 0.90, 1), "dark.textMuted")
        assertColor(t.accent, (0.40, 0.72, 0.82, 1), "dark.accent")
        assertColor(t.accent2, (0.55, 0.70, 1.00, 1), "dark.accent2")
        assertColor(t.accent3, (0.38, 0.90, 0.65, 1), "dark.accent3")
        assertColor(t.accent4, (0.98, 0.82, 0.40, 1), "dark.accent4")
        assertColor(t.danger, (0.96, 0.50, 0.50, 1), "dark.danger")
        assertColor(t.rowAlt, (1, 1, 1, 0.04), "dark.rowAlt")
        assertColor(t.gridLine, (1, 1, 1, 0.12), "dark.gridLine")
    }

    func test_darkCategoryHues() {
        assertColor(Theme.dark.categoryPurple, (0.70, 0.56, 0.95, 1), "dark.categoryPurple")
        assertColor(Theme.dark.categoryTeal, (0.42, 0.78, 0.82, 1), "dark.categoryTeal")
        assertColor(Theme.dark.categoryAmber, (0.90, 0.70, 0.35, 1), "dark.categoryAmber")
    }

    // MARK: - Light

    func test_lightRoles() {
        let t = Theme.light
        assertColor(t.body, (0.97, 0.97, 0.98, 1), "light.body")
        assertColor(t.surface, (1, 1, 1, 1), "light.surface")
        assertColor(t.surface2, (0.95, 0.96, 0.98, 1), "light.surface2")
        assertColor(t.border, (0, 0, 0, 0.10), "light.border")
        assertColor(t.text, (0.12, 0.14, 0.18, 1), "light.text")
        assertColor(t.textMuted, (0.39, 0.43, 0.52, 1), "light.textMuted")
        assertColor(t.accent, (0.18, 0.49, 0.56, 1), "light.accent")
        assertColor(t.accent2, (0.20, 0.40, 0.85, 1), "light.accent2")
        assertColor(t.accent3, (0.18, 0.65, 0.40, 1), "light.accent3")
        assertColor(t.accent4, (0.85, 0.55, 0.10, 1), "light.accent4")
        assertColor(t.danger, (0.80, 0.20, 0.20, 1), "light.danger")
        assertColor(t.rowAlt, (0, 0, 0, 0.025), "light.rowAlt")
        assertColor(t.gridLine, (0, 0, 0, 0.08), "light.gridLine")
    }

    func test_lightCategoryHues() {
        assertColor(Theme.light.categoryPurple, (0.52, 0.36, 0.78, 1), "light.categoryPurple")
        assertColor(Theme.light.categoryTeal, (0.10, 0.52, 0.55, 1), "light.categoryTeal")
        assertColor(Theme.light.categoryAmber, (0.72, 0.48, 0.08, 1), "light.categoryAmber")
    }

    // MARK: - Midnight

    func test_midnightRoles() {
        let t = Theme.midnight
        assertColor(t.body, (0.06, 0.07, 0.13, 1), "midnight.body")
        assertColor(t.surface, (0.12, 0.14, 0.21, 1), "midnight.surface")
        assertColor(t.surface2, (0.17, 0.19, 0.27, 1), "midnight.surface2")
        assertColor(t.border, (1, 1, 1, 0.16), "midnight.border")
        assertColor(t.text, (0.93, 0.95, 0.99, 1), "midnight.text")
        assertColor(t.textMuted, (0.78, 0.83, 0.93, 1), "midnight.textMuted")
        assertColor(t.accent, (0.55, 0.74, 1.00, 1), "midnight.accent")
        assertColor(t.accent2, (0.65, 0.82, 1.00, 1), "midnight.accent2")
        assertColor(t.accent3, (0.45, 0.92, 0.72, 1), "midnight.accent3")
        assertColor(t.accent4, (0.99, 0.85, 0.50, 1), "midnight.accent4")
        assertColor(t.danger, (0.98, 0.55, 0.55, 1), "midnight.danger")
        assertColor(t.rowAlt, (1, 1, 1, 0.04), "midnight.rowAlt")
        assertColor(t.gridLine, (1, 1, 1, 0.12), "midnight.gridLine")
    }

    func test_midnightCategoryHues() {
        assertColor(Theme.midnight.categoryPurple, (0.76, 0.64, 1.00, 1), "midnight.categoryPurple")
        assertColor(Theme.midnight.categoryTeal, (0.52, 0.86, 0.90, 1), "midnight.categoryTeal")
        assertColor(Theme.midnight.categoryAmber, (0.95, 0.78, 0.45, 1), "midnight.categoryAmber")
    }

    // MARK: - Spacing, radius

    func test_spacingScale() {
        XCTAssertEqual(Spacing.xs, 4)
        XCTAssertEqual(Spacing.sm, 8)
        XCTAssertEqual(Spacing.md, 12)
        XCTAssertEqual(Spacing.lg, 16)
        XCTAssertEqual(Spacing.xl, 24)
        XCTAssertEqual(Spacing.xxl, 32)
    }

    func test_radiusScale() {
        XCTAssertEqual(Radius.sm, 6)
        XCTAssertEqual(Radius.md, 10)
        XCTAssertEqual(Radius.lg, 14)
    }
    // MARK: - Typography

    /// Expected expressions copied from the original Theme.swift, so a token or
    /// `Typography.font` change that alters any font fails here.
    func test_typography() {
        XCTAssertEqual(Typography.display, Font.system(size: 26, weight: .bold))
        XCTAssertEqual(Typography.title, Font.system(size: 18, weight: .semibold))
        XCTAssertEqual(Typography.section, Font.system(size: 12, weight: .semibold))
        XCTAssertEqual(Typography.body, Font.system(size: 13))
        XCTAssertEqual(Typography.bodyStrong, Font.system(size: 13, weight: .semibold))
        XCTAssertEqual(Typography.caption, Font.system(size: 11))
        XCTAssertEqual(Typography.captionStrong, Font.system(size: 11, weight: .semibold))
        XCTAssertEqual(Typography.mono, Font.system(size: 11, design: .monospaced))
        XCTAssertEqual(Typography.filename, Font.system(size: 12))
        XCTAssertEqual(Typography.fileMeta, Font.system(size: 10))
        XCTAssertEqual(Typography.treeHeader, Font.system(size: 10, weight: .semibold))
        XCTAssertEqual(Typography.emptyTitle, Font.callout.weight(.medium))
        XCTAssertEqual(Typography.emptyHint, Font.caption)
        XCTAssertEqual(Typography.button, Font.callout.weight(.medium))
    }
}
