import SwiftUI

/// Palette structure adapted from gitlab-gantt-mac so visual identity
/// stays consistent across our two macOS apps.  Each theme is a flat
/// struct of named roles — view code uses `theme.text`, never literal
/// hex values — so a future palette tweak is a one-line change.
struct Theme: Equatable, Identifiable {
    let id: String
    let name: String
    let isDark: Bool
    let body: Color
    let surface: Color
    let surface2: Color
    let border: Color
    let text: Color
    let textMuted: Color
    let accent: Color       // brand
    let accent2: Color      // info / link
    let accent3: Color      // success
    let accent4: Color      // warning
    let danger: Color
    let rowAlt: Color
    let gridLine: Color
    // Sidebar category hues (Library). Purple and teal have no palette slot,
    // so each theme authors them; see the category notes below.
    let categoryPurple: Color
    let categoryTeal: Color
    let categoryAmber: Color

    /// Every theme's values come from `ThemeTokens` (generated from
    /// schema/design/tokens.json), so the Mac app, the Tauri desktop and the
    /// extension share one palette.
    static let all: [Theme] = ThemeTokens.palettes.map { Theme(palette: $0) }

    // Dark palette tuned for WCAG-AA contrast on small text against
    // both `body` and `surface`.  Surface sits ~7% above body so cards
    // visibly lift; muted text is bright enough (~4.7:1 on surface) to
    // read at a glance.
    static let dark = Theme(palette: ThemeTokens.dark)

    static let light = Theme(palette: ThemeTokens.light)

    static let midnight = Theme(palette: ThemeTokens.midnight)

    static func find(id: String) -> Theme {
        all.first(where: { $0.id == id }) ?? .dark
    }

    init(palette p: ThemeTokens.Palette) {
        id = p.id
        name = p.name
        isDark = p.isDark
        body = Theme.color(p.body)
        surface = Theme.color(p.surface)
        surface2 = Theme.color(p.surface2)
        border = Theme.color(p.border)
        text = Theme.color(p.text)
        textMuted = Theme.color(p.textMuted)
        accent = Theme.color(p.accent)
        accent2 = Theme.color(p.accent2)
        accent3 = Theme.color(p.accent3)
        accent4 = Theme.color(p.accent4)
        danger = Theme.color(p.danger)
        rowAlt = Theme.color(p.rowAlt)
        gridLine = Theme.color(p.gridLine)
        categoryPurple = Theme.color(p.categoryPurple)
        categoryTeal = Theme.color(p.categoryTeal)
        categoryAmber = Theme.color(p.categoryAmber)
    }

    /// Builds the SwiftUI colour for a token. `Color.white` / `Color.black`
    /// are used for the keyword swatches so the value is the same expression
    /// the palette was originally written with.
    static func color(_ s: ThemeTokens.Swatch) -> Color {
        switch s {
        case let .rgb(r, g, b): return Color(red: r, green: g, blue: b)
        case let .white(a): return a == 1 ? Color.white : Color.white.opacity(a)
        case let .black(a): return a == 1 ? Color.black : Color.black.opacity(a)
        }
    }
}

// MARK: - Semantic aliases
//
// Views should express intent (success/warning/info) rather than slot
// names, and must never use raw system colors (.green/.orange/.red) —
// those ignore the active palette and look wrong in Midnight.
extension Theme {
    var success: Color { accent3 }
    var warning: Color { accent4 }
    var info: Color { accent2 }

    // MARK: - Sidebar category hues
    //
    // The Library sidebar colour-codes its sections. Blue/green/brand map
    // straight onto palette slots; purple, teal and amber have no slot, so
    // each theme authors them in tokens.json (`categoryPurple`, `categoryTeal`,
    // `categoryAmber`) — never raw `.purple` / `.teal`, which wash out in
    // Midnight. Amber is LLM Sources' hue, kept distinct from Plugins' teal.

    /// Single source of truth for a Library file-tree section's tint, derived
    /// from the active palette. Sources/Notes read as the blue (info) family,
    /// Code as green (success), Data as purple.
    func tint(for category: LibraryItem.Category) -> Color {
        switch category {
        case .meetings, .notes: return info
        case .code:             return success
        case .data:             return categoryPurple
        }
    }

    // MARK: - Diff / git / editor tokens
    //
    // Derived from the existing semantic aliases, not new literals: this is
    // what keeps them theme-correct (Dark/Light/Midnight all agree with the
    // rest of the app's palette) without touching the three `static let`
    // palette definitions above. Views must read these — never raw
    // `Color.green`/`.red`/`.orange` — the rule `Theme.swift`'s own header
    // comment already states for `success`/`warning`/`info`.

    var diffAddedFg: Color { success }
    var diffAddedBg: Color { success.opacity(0.16) }
    var diffDeletedFg: Color { danger }
    var diffDeletedBg: Color { danger.opacity(0.16) }

    // Editor gutter marks (added/modified/deleted line markers).
    var gutterAddedMark: Color { success }
    var gutterModifiedMark: Color { info }
    var gutterDeletedMark: Color { danger }

    // Monaco theme base colors.
    var editorBackground: Color { body }
    var editorLineNumber: Color { textMuted }

    /// Source Control changes-list badge/text color for a file's status.
    /// Mirrors `SourceControlView`'s original raw-color mapping — same
    /// cases, same fallback — but through Theme so Midnight reads correctly.
    func color(for status: FileChange.Status) -> Color {
        switch status {
        case .added, .untracked: return success
        case .deleted: return danger
        case .conflicted: return warning
        default: return accent2
        }
    }

    /// File-tree decoration color for a git decoration. Deliberately case-for-
    /// case identical to `color(for: FileChange.Status)` above: the Explorer
    /// tree and the Source Control changes list describe the same repository,
    /// so a file that is blue in one must be blue in the other. `TreeRowLabel`
    /// previously hardcoded its own amber/green/red hex triples, which is what
    /// let the two panels drift.
    func color(for decoration: GitTruthStore.Decoration) -> Color {
        switch decoration {
        case .added, .untracked: return success
        case .deleted: return danger
        case .conflicted: return warning
        case .modified: return info
        }
    }
}

/// Convenience wrapper so views can read the active theme via
/// `@EnvironmentObject` and react to changes through Combine.
final class ThemeStore: ObservableObject {
    @Published var current: Theme

    init(initial: Theme = .dark) {
        self.current = initial
    }

    func apply(id: String) {
        current = Theme.find(id: id)
    }
}

// MARK: - Design tokens
//
// These are the only "magic numbers" the views are allowed to use.
// Centralizing them means a future polish pass tightens the whole UI
// from one file rather than chasing a thousand call sites.

// The numbers come from `ThemeTokens` (schema/design/tokens.json). Each name
// keeps its meaning: see the comments in tokens.json for the intent of a role.

enum Spacing {
    static let xs: CGFloat = CGFloat(ThemeTokens.spacing.xs)
    static let sm: CGFloat = CGFloat(ThemeTokens.spacing.sm)
    static let md: CGFloat = CGFloat(ThemeTokens.spacing.md)
    static let lg: CGFloat = CGFloat(ThemeTokens.spacing.lg)
    static let xl: CGFloat = CGFloat(ThemeTokens.spacing.xl)
    static let xxl: CGFloat = CGFloat(ThemeTokens.spacing.xxl)
}

enum Radius {
    static let sm: CGFloat = CGFloat(ThemeTokens.radius.sm)
    static let md: CGFloat = CGFloat(ThemeTokens.radius.md)
    static let lg: CGFloat = CGFloat(ThemeTokens.radius.lg)
}

enum Typography {
    // MARK: - Scale

    /// Display — page titles, hero copy.
    static let display      = font(ThemeTokens.typeScale.display)
    /// Title — view titles, large card headers.
    static let title        = font(ThemeTokens.typeScale.title)
    /// Section heading — used in side panels, settings cards.
    static let section      = font(ThemeTokens.typeScale.section)
    /// Body text — default prose.
    static let body         = font(ThemeTokens.typeScale.body)
    /// Body semibold — emphasis, interactive labels.
    static let bodyStrong   = font(ThemeTokens.typeScale.bodyStrong)
    /// Caption — metadata, hints, secondary text.
    static let caption      = font(ThemeTokens.typeScale.caption)
    /// Caption semibold — chip/badge labels.
    static let captionStrong = font(ThemeTokens.typeScale.captionStrong)
    /// Mono — code refs, IDs, timestamps.
    static let mono         = font(ThemeTokens.typeScale.mono)

    // MARK: - File browser tokens (tree panel + library list)

    /// File and folder names in tree/list rows.
    static let filename     = font(ThemeTokens.typeScale.filename)
    /// Secondary metadata under file rows (extension, file size).
    static let fileMeta     = font(ThemeTokens.typeScale.fileMeta)
    /// EXPLORER / DOCUMENTS / CODE & NOTES panel headers.
    static let treeHeader   = font(ThemeTokens.typeScale.treeHeader)

    // MARK: - Empty / placeholder states

    /// Primary label in an empty-state placeholder.
    static let emptyTitle   = font(ThemeTokens.typeScale.emptyTitle)
    /// Secondary hint text in an empty-state placeholder.
    static let emptyHint    = font(ThemeTokens.typeScale.emptyHint)

    // MARK: - Interactive controls

    /// Primary action buttons (Record, New Change…).
    static let button       = font(ThemeTokens.typeScale.button)

    /// Turns a `ThemeTokens.TypeToken` into a SwiftUI font. A text-style token
    /// keeps the system size (`Font.callout` / `Font.caption`); a size token
    /// uses `Font.system(size:)`. A nil weight or design is passed through as
    /// nil, so the call matches the original `Font.system(size:…)` exactly.
    static func font(_ t: ThemeTokens.TypeToken) -> Font {
        let weight = t.weight.map(swiftWeight)
        if let style = t.textStyle {
            let base: Font = style == .callout ? .callout : .caption
            return weight.map { base.weight($0) } ?? base
        }
        return Font.system(
            size: CGFloat(t.size ?? 13),
            weight: weight,
            design: t.monospaced ? .monospaced : nil
        )
    }

    private static func swiftWeight(_ w: ThemeTokens.FontWeightToken) -> Font.Weight {
        switch w {
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        }
    }
}

/// Reusable card surface — subtle hairline border + correct corner
/// radius from the design tokens.  Use on every panel that should
/// feel "elevated" against the body background.
struct CardModifier: ViewModifier {
    @EnvironmentObject var theme: ThemeStore
    var padding: CGFloat = Spacing.md
    var radius: CGFloat = Radius.md

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.current.surface)
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(theme.current.border, lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: radius))
    }
}

extension View {
    func card(padding: CGFloat = Spacing.md, radius: CGFloat = Radius.md) -> some View {
        modifier(CardModifier(padding: padding, radius: radius))
    }
}

// MARK: - Monaco theme bridge

import AppKit

extension Color {
    /// "#RRGGBB", best-effort. Used only for embedding into Monaco's theme
    /// JSON — Theme's `Color` values remain the actual source of truth for
    /// every SwiftUI view; this is a one-way, lossy export for the WebView.
    func hexRGB() -> String {
        guard let rgb = NSColor(self).usingColorSpace(.deviceRGB) else { return "#000000" }
        let r = Int((rgb.redComponent * 255).rounded())
        let g = Int((rgb.greenComponent * 255).rounded())
        let b = Int((rgb.blueComponent * 255).rounded())
        return String(format: "#%02X%02X%02X", r, g, b)
    }

    /// "#RRGGBBAA", best-effort — same use as `hexRGB()`, but preserves the
    /// alpha channel. Monaco's theme color format accepts 8-digit hex, and
    /// callers like `diffAddedBg`/`diffDeletedBg` (defined as
    /// `.opacity(0.16)`) rely on that alpha to stay a subtle tint instead of
    /// an opaque block once painted behind diff text.
    func hexRGBA() -> String {
        guard let rgb = NSColor(self).usingColorSpace(.deviceRGB) else { return "#000000FF" }
        let r = Int((rgb.redComponent * 255).rounded())
        let g = Int((rgb.greenComponent * 255).rounded())
        let b = Int((rgb.blueComponent * 255).rounded())
        let a = Int((rgb.alphaComponent * 255).rounded())
        return String(format: "#%02X%02X%02X%02X", r, g, b, a)
    }
}

/// One entry of Monaco's `IStandaloneThemeData.rules` — a token-type →
/// color mapping for syntax highlighting. Kept minimal (foreground only,
/// no fontStyle) since only line/diff decoration colors are theme-critical
/// here; Monaco's bundled default-dark/default-light token colors are fine
/// for syntax highlighting itself.
struct MonacoThemeRule: Codable, Equatable {
    let token: String
    let foreground: String?
}

/// Mirrors Monaco's `monaco.editor.defineTheme(name, data)` `data` shape
/// (`IStandaloneThemeData`). `base` must be one of Monaco's four built-in
/// base themes; `inherit: true` means unset `colors` keys fall back to that
/// base theme's own values.
struct MonacoTheme: Codable, Equatable {
    let base: String
    let inherit: Bool
    let rules: [MonacoThemeRule]
    let colors: [String: String]
}

extension Theme {
    /// The `IStandaloneThemeData` Monaco needs to render in this app's
    /// palette. `base` selects Monaco's built-in dark/light base (Midnight
    /// is a dark palette, so it inherits "vs-dark" too — `Theme.isDark`
    /// already models exactly this distinction for every other consumer).
    func monacoTheme() -> MonacoTheme {
        MonacoTheme(
            base: isDark ? "vs-dark" : "vs",
            inherit: true,
            rules: [],
            colors: [
                "editor.background": editorBackground.hexRGB(),
                "editor.foreground": text.hexRGB(),
                "editorLineNumber.foreground": editorLineNumber.hexRGB(),
                "editorLineNumber.activeForeground": text.hexRGB(),
                "editorGutter.addedBackground": gutterAddedMark.hexRGB(),
                "editorGutter.modifiedBackground": gutterModifiedMark.hexRGB(),
                "editorGutter.deletedBackground": gutterDeletedMark.hexRGB(),
                "diffEditor.insertedTextBackground": diffAddedBg.hexRGBA(),
                "diffEditor.removedTextBackground": diffDeletedBg.hexRGBA(),
            ]
        )
    }

    /// `monacoTheme()` as a JSON string, ready to cross the JS bridge as a
    /// `callAsyncJavaScript` argument (never spliced into JS source — see
    /// `MonacoBridge.setTheme`). Falls back to an empty object rather than
    /// throwing: a failed encode should degrade to Monaco's own default
    /// theme, not crash the host.
    func monacoThemeJSON() -> String {
        guard let data = try? JSONEncoder().encode(monacoTheme()),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }
}
