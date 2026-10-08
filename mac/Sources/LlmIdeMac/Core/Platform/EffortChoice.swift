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

    /// The levels of the model a turn will run on. `modelId` "" = none
    /// chosen, so the server's default runs — the listing's first row. A
    /// saved id can differ from the listed one by a suffix ("[1m]", a date
    /// snapshot); `baseId` (AIModel.baseId) bridges that.
    public static func levels(forModelId modelId: String,
                              in rows: [(id: String, levels: [String])],
                              baseId: (String) -> String) -> [String] {
        if modelId.isEmpty { return rows.first?.levels ?? [] }
        if let exact = rows.first(where: { $0.id == modelId }) { return exact.levels }
        let base = baseId(modelId)
        if let same = rows.first(where: { baseId($0.id) == base }) { return same.levels }
        // Last chance: the same model spelled differently ("claude-sonnet-5.5",
        // a "-latest" alias). Without it the effort section vanished for an id
        // the list does carry, just not in this spelling.
        let normalized = ModelDisplayName.normalizedId(modelId)
        return rows.first(where: { ModelDisplayName.normalizedId($0.id) == normalized })?.levels ?? []
    }
}
