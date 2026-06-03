import Foundation

/// Centralized user-facing strings.  Keeps copy reviewable in one place
/// and gives us a hook for localization later (NSLocalizedString lookups
/// can be inserted here without touching every call site).
enum L {
    enum App {
        static let name = "Meet Notes"
    }
}
