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

    static let all: [Theme] = [.dark, .light, .midnight]

    // Dark palette tuned for WCAG-AA contrast on small text against
    // both `body` and `surface`.  Surface sits ~7% above body so cards
    // visibly lift; muted text is bright enough (~4.7:1 on surface) to
    // read at a glance.
    static let dark = Theme(
        id: "dark", name: "Dark", isDark: true,
        body: Color(red: 0.07, green: 0.08, blue: 0.11),
        surface: Color(red: 0.14, green: 0.15, blue: 0.20),
        surface2: Color(red: 0.19, green: 0.20, blue: 0.26),
        border: Color.white.opacity(0.14),
        text: Color(red: 0.94, green: 0.95, blue: 0.98),
        textMuted: Color(red: 0.78, green: 0.81, blue: 0.90),
        accent: Color(red: 0.40, green: 0.72, blue: 0.82),     // meet-notes teal, lifted for dark BG
        accent2: Color(red: 0.55, green: 0.70, blue: 1.00),
        accent3: Color(red: 0.38, green: 0.90, blue: 0.65),
        accent4: Color(red: 0.98, green: 0.82, blue: 0.40),
        danger: Color(red: 0.96, green: 0.50, blue: 0.50),
        rowAlt: Color.white.opacity(0.04),
        gridLine: Color.white.opacity(0.12)
    )

    static let light = Theme(
        id: "light", name: "Light", isDark: false,
        body: Color(red: 0.97, green: 0.97, blue: 0.98),
        surface: Color.white,
        surface2: Color(red: 0.95, green: 0.96, blue: 0.98),
        border: Color.black.opacity(0.10),
        text: Color(red: 0.12, green: 0.14, blue: 0.18),
        textMuted: Color(red: 0.42, green: 0.46, blue: 0.55),
        accent: Color(red: 0.18, green: 0.49, blue: 0.56),
        accent2: Color(red: 0.20, green: 0.40, blue: 0.85),
        accent3: Color(red: 0.18, green: 0.65, blue: 0.40),
        accent4: Color(red: 0.85, green: 0.55, blue: 0.10),
        danger: Color(red: 0.80, green: 0.20, blue: 0.20),
        rowAlt: Color.black.opacity(0.025),
        gridLine: Color.black.opacity(0.08)
    )

    static let midnight = Theme(
        id: "midnight", name: "Midnight", isDark: true,
        body: Color(red: 0.06, green: 0.07, blue: 0.13),
        surface: Color(red: 0.12, green: 0.14, blue: 0.21),
        surface2: Color(red: 0.17, green: 0.19, blue: 0.27),
        border: Color.white.opacity(0.16),
        text: Color(red: 0.93, green: 0.95, blue: 0.99),
        textMuted: Color(red: 0.78, green: 0.83, blue: 0.93),
        accent: Color(red: 0.55, green: 0.74, blue: 1.00),
        accent2: Color(red: 0.65, green: 0.82, blue: 1.00),
        accent3: Color(red: 0.45, green: 0.92, blue: 0.72),
        accent4: Color(red: 0.99, green: 0.85, blue: 0.50),
        danger: Color(red: 0.98, green: 0.55, blue: 0.55),
        rowAlt: Color.white.opacity(0.04),
        gridLine: Color.white.opacity(0.12)
    )

    static func find(id: String) -> Theme {
        all.first(where: { $0.id == id }) ?? .dark
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

enum Spacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

enum Radius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 14
}

enum Typography {
    // MARK: - Scale

    /// Display — page titles, hero copy.
    static let display      = Font.system(size: 26, weight: .bold)
    /// Title — view titles, large card headers.
    static let title        = Font.system(size: 18, weight: .semibold)
    /// Section heading — used in side panels, settings cards.
    static let section      = Font.system(size: 12, weight: .semibold)
    /// Body text — default prose.
    static let body         = Font.system(size: 13)
    /// Body semibold — emphasis, interactive labels.
    static let bodyStrong   = Font.system(size: 13, weight: .semibold)
    /// Caption — metadata, hints, secondary text.
    static let caption      = Font.system(size: 11)
    /// Caption semibold — chip/badge labels.
    static let captionStrong = Font.system(size: 11, weight: .semibold)
    /// Mono — code refs, IDs, timestamps.
    static let mono         = Font.system(size: 11, design: .monospaced)

    // MARK: - File browser tokens (tree panel + library list)

    /// File and folder names in tree/list rows.
    static let filename     = Font.system(size: 12)
    /// Secondary metadata under file rows (extension, file size).
    static let fileMeta     = Font.system(size: 10)
    /// EXPLORER / DOCUMENTS / CODE & NOTES panel headers.
    static let treeHeader   = Font.system(size: 10, weight: .semibold)

    // MARK: - Empty / placeholder states

    /// Primary label in an empty-state placeholder.
    static let emptyTitle   = Font.callout.weight(.medium)
    /// Secondary hint text in an empty-state placeholder.
    static let emptyHint    = Font.caption

    // MARK: - Interactive controls

    /// Primary action buttons (Record, New Change…).
    static let button       = Font.callout.weight(.medium)
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
