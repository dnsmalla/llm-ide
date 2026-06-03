import Foundation

/// Registry of platform-specific scrapers.  Adding a new platform is
/// a one-file addition + one entry here; the orchestrator picks the
/// first that reports `isAvailable()` and never sees the others.
enum PlatformDetector {
    static let allScrapers: [CaptionScraper] = [
        ZoomCaptionScraper(),
        TeamsCaptionScraper(),
    ]
}
