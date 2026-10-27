import Foundation

/// The `docGenUseServerStore` preference: when on, Doc Gen's project template
/// and command files are listed, saved, deleted and seeded through the server
/// (`/kb/docs/*`); when off, the Swift path runs exactly as before and no
/// request is made for them. Default off (docs-kit §5a).
///
/// Flip it with `defaults write <bundle id> docGenUseServerStore -bool YES`
/// (the Settings card, Doc Gen → Settings, does the same).
struct DocGenServerStorePreference {
    static let key = "docGenUseServerStore"

    /// Production reads `UserDefaults.standard`; tests pass a suite.
    let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Off unless the key is set to true. A missing key reads as false.
    var isOn: Bool {
        defaults.bool(forKey: Self.key)
    }
}
