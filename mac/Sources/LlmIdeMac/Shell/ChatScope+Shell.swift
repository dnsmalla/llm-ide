import Foundation

// Kept in Shell, not next to `ChatScope` in Core/Contracts: it maps a chat
// scope onto a `ShellState.Section`, and Shell is the only layer allowed to
// name both. Defining it on the enum itself made Chat depend on Shell.
extension ChatScope {
    /// The sidebar section that hosts this scope's `CodeAssistantPanel`, so a
    /// caller holding only a `ChatScope` (e.g. `ChatEngineRegistry`) can route
    /// the user to it. Nil for `.quick` — it has no section, it's reached by
    /// opening the LLM Chat sheet or the menu-bar window instead.
    var shellSection: ShellState.Section? {
        switch self {
        case .explorer: return .explorer
        case .conflicts: return .conflicts
        case .visual: return .visual
        case .docGen: return .docGen
        case .quick: return nil
        }
    }
}
