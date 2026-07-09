import Foundation

/// A planned input source — shown in the Inputs hub as a muted "coming soon"
/// add-on so the section reads as intentionally extensible.
struct PlannedInputSource: Identifiable {
    let id: String
    let icon: String
    let title: String
    let subtitle: String
}

/// Registry of input-source add-ons, the config-layer parallel to
/// `PlatformDetector.allScrapers`. Live sources (Meetings, Email) have their
/// own cards in `ConnectionsSettingsSection`; everything here is announced as
/// upcoming.
///
/// To promote a planned source to live: build its `InputSourceCard` in
/// `ConnectionsSettingsSection` (with its config + fetch wiring) and remove it
/// from this list — one card + one deletion, mirroring how a new
/// `CaptionScraper` is one file plus one registry entry.
enum InputSourceRegistry {
    static let planned: [PlannedInputSource] = [
        // No planned sources - remove when ready to add one
    ]
}
