import Foundation

/// The composer's reasoning-effort pick, reduced to the rules a test can pin.
///
/// The levels themselves are never listed here: they come from the server's
/// model listing (`effortLevels`, the Agent SDK's own `supportedEffortLevels`),
/// so a level a newer SDK adds shows up in the picker without an app change.
public enum EffortChoice {
    /// Let the server choose per turn (its `effortForTurn`).
    public static let auto = "auto"
    /// One app-wide pick, not per chat.
    public static let defaultsKey = "chat.effort"

    /// What a turn sends: the stored pick when the model offers it, else auto.
    /// The stored pick itself is left alone, so switching back to a model
    /// that offers it restores it.
    public static func effective(stored: String, levels: [String]) -> String {
        levels.contains(stored) ? stored : auto
    }

    /// Display name: the raw level with its first letter capitalised. No
    /// name table, so an unknown level still reads sensibly.
    public static func label(_ level: String) -> String {
        guard let first = level.first else { return level }
        return first.uppercased() + level.dropFirst()
    }
}
