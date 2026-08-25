import Foundation

/// Single source of truth for which meeting platforms LLM-IDE captures
/// natively on macOS vs via the Chrome extension. `PlatformDetector` only
/// registers native scrapers — this matrix is what user-facing copy should cite.
enum MeetingCaptureMatrix {
    struct Platform: Equatable, Identifiable, Sendable {
        let id: String
        let displayName: String
        /// `CaptureSource.rawValue` implemented by the native scraper, or nil
        /// when this platform is extension-only.
        let nativeSourceRawValue: String?
        let chromeExtension: Bool

        var nativeMac: Bool { nativeSourceRawValue != nil }
    }

    static let platforms: [Platform] = [
        Platform(id: "zoom", displayName: "Zoom",
                 nativeSourceRawValue: CaptureSource.zoomDesktop.rawValue, chromeExtension: true),
        Platform(id: "teams", displayName: "Microsoft Teams",
                 nativeSourceRawValue: CaptureSource.teamsDesktop.rawValue, chromeExtension: true),
        Platform(id: "meet", displayName: "Google Meet",
                 nativeSourceRawValue: nil, chromeExtension: true),
    ]

    /// Settings → Connections → Meetings card subtitle.
    static let connectionsSubtitle = "Zoom · Teams (Mac app) · Meet (extension)"

    /// Auto-capture toggle helper under Settings → Connections.
    static let autoCaptureDetail =
        "Auto-starts when the Zoom or Teams desktop app is frontmost. "
        + "Google Meet and web clients use the Chrome extension."

    /// Permissions onboarding — Accessibility row detail.
    static let accessibilityDetail =
        "Read live captions from Zoom and Teams desktop apps. "
        + "Google Meet uses the Chrome extension."

    /// One-line note for help/onboarding footers.
    static let extensionNote =
        "Google Meet, Teams web, and Zoom web are captured by the Chrome extension; "
        + "the Live tab mirrors those sessions in real time."

    static var nativePlatformNames: String {
        platforms.filter(\.nativeMac).map(\.displayName).joined(separator: " and ")
    }

    static var extensionOnlyPlatformNames: String {
        platforms.filter { !$0.nativeMac && $0.chromeExtension }.map(\.displayName).joined(separator: " and ")
    }
}
