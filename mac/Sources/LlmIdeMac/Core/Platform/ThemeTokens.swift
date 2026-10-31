// GENERATED - do not edit.
// Source: schema/design/tokens.json
// Regenerate with `node scripts/gen-design-tokens.mjs` (or `make design-tokens`).
// Check with `node scripts/gen-design-tokens.mjs --check` (part of `make contract-gates`).
//
// Plain values only (no SwiftUI, no dependencies). Core/Platform/Theme.swift
// turns these into Color and Font, so every Theme value is the one written in
// tokens.json.

enum ThemeTokens {
    /// One colour as authored in tokens.json: sRGB components, or Color.white /
    /// Color.black at an opacity.
    enum Swatch {
        case rgb(Double, Double, Double)
        case white(Double)
        case black(Double)
    }

    /// One theme's colour roles.
    struct Palette {
        let id: String
        let name: String
        let isDark: Bool
        let body: Swatch
        let surface: Swatch
        let surface2: Swatch
        let border: Swatch
        let text: Swatch
        let textMuted: Swatch
        let accent: Swatch
        let accent2: Swatch
        let accent3: Swatch
        let accent4: Swatch
        let danger: Swatch
        let rowAlt: Swatch
        let gridLine: Swatch
        let categoryPurple: Swatch
        let categoryTeal: Swatch
        let categoryAmber: Swatch
    }

    static let dark = Palette(
        id: "dark",
        name: "Dark",
        isDark: true,
        body: .rgb(0.07, 0.08, 0.11),
        surface: .rgb(0.14, 0.15, 0.2),
        surface2: .rgb(0.19, 0.2, 0.26),
        border: .white(0.14),
        text: .rgb(0.94, 0.95, 0.98),
        textMuted: .rgb(0.78, 0.81, 0.9),
        accent: .rgb(0.4, 0.72, 0.82),
        accent2: .rgb(0.55, 0.7, 1),
        accent3: .rgb(0.38, 0.9, 0.65),
        accent4: .rgb(0.98, 0.82, 0.4),
        danger: .rgb(0.96, 0.5, 0.5),
        rowAlt: .white(0.04),
        gridLine: .white(0.12),
        categoryPurple: .rgb(0.7, 0.56, 0.95),
        categoryTeal: .rgb(0.42, 0.78, 0.82),
        categoryAmber: .rgb(0.9, 0.7, 0.35)
    )

    static let light = Palette(
        id: "light",
        name: "Light",
        isDark: false,
        body: .rgb(0.97, 0.97, 0.98),
        surface: .white(1),
        surface2: .rgb(0.95, 0.96, 0.98),
        border: .black(0.1),
        text: .rgb(0.12, 0.14, 0.18),
        textMuted: .rgb(0.39, 0.43, 0.52),
        accent: .rgb(0.18, 0.49, 0.56),
        accent2: .rgb(0.2, 0.4, 0.85),
        accent3: .rgb(0.18, 0.65, 0.4),
        accent4: .rgb(0.85, 0.55, 0.1),
        danger: .rgb(0.8, 0.2, 0.2),
        rowAlt: .black(0.025),
        gridLine: .black(0.08),
        categoryPurple: .rgb(0.52, 0.36, 0.78),
        categoryTeal: .rgb(0.1, 0.52, 0.55),
        categoryAmber: .rgb(0.72, 0.48, 0.08)
    )

    static let midnight = Palette(
        id: "midnight",
        name: "Midnight",
        isDark: true,
        body: .rgb(0.06, 0.07, 0.13),
        surface: .rgb(0.12, 0.14, 0.21),
        surface2: .rgb(0.17, 0.19, 0.27),
        border: .white(0.16),
        text: .rgb(0.93, 0.95, 0.99),
        textMuted: .rgb(0.78, 0.83, 0.93),
        accent: .rgb(0.55, 0.74, 1),
        accent2: .rgb(0.65, 0.82, 1),
        accent3: .rgb(0.45, 0.92, 0.72),
        accent4: .rgb(0.99, 0.85, 0.5),
        danger: .rgb(0.98, 0.55, 0.55),
        rowAlt: .white(0.04),
        gridLine: .white(0.12),
        categoryPurple: .rgb(0.76, 0.64, 1),
        categoryTeal: .rgb(0.52, 0.86, 0.9),
        categoryAmber: .rgb(0.95, 0.78, 0.45)
    )

    /// Every theme, in the order Theme.all lists them.
    static let palettes: [Palette] = [dark, light, midnight]

    struct SpacingScale {
        let xs: Double
        let sm: Double
        let md: Double
        let lg: Double
        let xl: Double
        let xxl: Double
    }

    static let spacing = SpacingScale(
        xs: 4,
        sm: 8,
        md: 12,
        lg: 16,
        xl: 24,
        xxl: 32
    )

    struct RadiusScale {
        let sm: Double
        let md: Double
        let lg: Double
    }

    static let radius = RadiusScale(
        sm: 6,
        md: 10,
        lg: 14
    )

    enum FontWeightToken {
        case regular
        case medium
        case semibold
        case bold
    }

    /// A platform text style (size comes from the system), used for the
    /// empty-state and button roles.
    enum TextStyleToken {
        case callout
        case caption
    }

    struct TypeToken {
        /// Point size; nil when `textStyle` supplies the size.
        let size: Double?
        let textStyle: TextStyleToken?
        let weight: FontWeightToken?
        let monospaced: Bool
    }

    struct TypeScale {
        let display: TypeToken
        let title: TypeToken
        let section: TypeToken
        let body: TypeToken
        let bodyStrong: TypeToken
        let caption: TypeToken
        let captionStrong: TypeToken
        let mono: TypeToken
        let filename: TypeToken
        let fileMeta: TypeToken
        let treeHeader: TypeToken
        let emptyTitle: TypeToken
        let emptyHint: TypeToken
        let button: TypeToken
    }

    static let typeScale = TypeScale(
        display: TypeToken(size: 26, textStyle: nil, weight: .bold, monospaced: false),
        title: TypeToken(size: 18, textStyle: nil, weight: .semibold, monospaced: false),
        section: TypeToken(size: 12, textStyle: nil, weight: .semibold, monospaced: false),
        body: TypeToken(size: 13, textStyle: nil, weight: nil, monospaced: false),
        bodyStrong: TypeToken(size: 13, textStyle: nil, weight: .semibold, monospaced: false),
        caption: TypeToken(size: 11, textStyle: nil, weight: nil, monospaced: false),
        captionStrong: TypeToken(size: 11, textStyle: nil, weight: .semibold, monospaced: false),
        mono: TypeToken(size: 11, textStyle: nil, weight: nil, monospaced: true),
        filename: TypeToken(size: 12, textStyle: nil, weight: nil, monospaced: false),
        fileMeta: TypeToken(size: 10, textStyle: nil, weight: nil, monospaced: false),
        treeHeader: TypeToken(size: 10, textStyle: nil, weight: .semibold, monospaced: false),
        emptyTitle: TypeToken(size: nil, textStyle: .callout, weight: .medium, monospaced: false),
        emptyHint: TypeToken(size: nil, textStyle: .caption, weight: nil, monospaced: false),
        button: TypeToken(size: nil, textStyle: .callout, weight: .medium, monospaced: false)
    )
}
