import Foundation

/// The words for the upgrade path (K1 Phase 6): the classic engine is gone, so the keys a user already had
/// were carried over into the provider catalog by the server, and chat on a catalog model needs the session
/// router. Shared by the Provider catalog card (Settings) and the composer's model menu (Chat).
enum ProviderMigrationText {
    /// "Your DeepSeek key was added as a catalog connection. The old key is kept."
    static func createdLine(_ names: [String]) -> String {
        let list = names.joined(separator: ", ")
        let noun = names.count == 1 ? "key was" : "keys were"
        return "Your existing \(list) \(noun) added as catalog connections. The old keys are kept."
    }

    static func reviewLine(name: String, reason: String) -> String {
        "\(name) needs review: it was not carried over (\(reason)). Connect it below once the address is fixed."
    }

    /// Why chat on a catalog model needs the router, and when the switch takes effect.
    static let routerNeeded = "Chat on these models runs through the session router. Turning it on applies the next time the backend starts."
    /// The visible switch for tools on provider models (never enabled by the migration).
    static let toolsSwitchLabel = "Allow tools on provider models"
    static let toolsExplanation = "Tool turns can read files and run commands, subject to your approvals. Without this, these models still answer in ask and document modes."

    static let routerPending = "The session router is on; it applies the next time the backend starts."
}
