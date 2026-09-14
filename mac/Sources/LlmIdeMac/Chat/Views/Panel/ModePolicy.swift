import Foundation

/// Mode-picker rules the chat lifecycle applies, kept out of the views and
/// the engine so both can change without touching the other.
///
/// Keyed on the mode's raw string (the wire value, and what message metadata
/// stores) so the rules stay assertable from `chat-contract-lab` without
/// making the SwiftUI-facing `CodeAssistMode` public.
public enum ModePolicy {

    /// The one mode that re-decides per turn; the target of every release.
    public static let autoMode = "auto"

    /// Wire values `CodeAssistMode` knows. Mirrors its `rawValue`s; an
    /// unknown server value must never move the picker.
    static let knownModes: Set<String> = [
        "auto", "plan", "assist_plan", "review", "document", "execute",
    ]

    /// Where the picker should move when the server resolves `resolved`
    /// for a turn, or nil to leave it. Only Auto ever follows: moving OFF
    /// Auto is the point (the user asked the picker to show what the agent
    /// is doing), and a mode picked by hand is not the server's to change.
    public static func pickerMode(current: String, resolved: String) -> String? {
        guard current == autoMode, resolved != autoMode, knownModes.contains(resolved) else { return nil }
        return resolved
    }
}
