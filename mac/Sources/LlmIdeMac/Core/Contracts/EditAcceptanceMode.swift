import Foundation

// Extracted verbatim from Features/Chat/Views/Panel/CodeAssistantPanel.swift.
// Core/Contracts because it is a cross-feature value: Chat renders and applies
// it, while Mobile Control reads the same stored preference to decide what a
// phone-driven turn may do — and features may not name each other. Its
// `ChipMenuOption` conformance (a Chat UI protocol) stays in Chat as an
// extension next to that protocol.

/// The chat's permission mode — Claude Code's three: Ask, Accept Edits,
/// Bypass. (Plan is the separate task-mode picker.) Raw values are the
/// stored preference: `review`/`auto` predate the rename and are kept so an
/// existing setting survives the upgrade.
enum EditAcceptanceMode: String, CaseIterable, Identifiable {
    /// Ask before edits and commands — unless you already chose "always
    /// allow" for that command in this project, or "allow all edits" in
    /// this chat.
    case review
    /// Apply file edits inside the project without asking; still ask before
    /// shell commands and write-tier git operations.
    case acceptEdits
    /// Apply edits and run proposed commands without asking (still gated by
    /// the server's blocklist and write containment, and
    /// `BashService.validateCommand` locally); GitLab/GitHub actions always
    /// confirm.
    case auto

    var id: String { rawValue }
    var label: String {
        switch self {
        case .review: return "Ask"
        case .acceptEdits: return "Accept Edits"
        case .auto: return "Bypass"
        }
    }
    var icon: String {
        switch self {
        case .review: return "hand.raised"
        case .acceptEdits: return "pencil.and.list.clipboard"
        case .auto: return "bolt.fill"
        }
    }
    var help: String {
        switch self {
        case .review:
            return "Ask before each file edit and shell command. \"Always allow\" on a card remembers that command for this project."
        case .acceptEdits:
            return "Apply file edits in the project without asking; still ask before shell commands."
        case .auto:
            return "Apply edits and run commands without asking. Blocked commands and writes outside the project are still refused."
        }
    }

    /// Edits are applied without a confirmation card.
    var autoAppliesEdits: Bool { self != .review }
    /// Shell commands and write-tier git ops run without a confirmation card.
    var autoRunsCommands: Bool { self == .auto }

    /// What this setting means to the Agent engine, which approves tools
    /// server-side and so has to be TOLD (the legacy loop applies the same
    /// setting client-side, in `ChatAutoChainPolicy`). Server API v55;
    /// an older server ignores `ask`/`accept-edits` and applies its own
    /// policy (it asks).
    var agentPermissionMode: String {
        switch self {
        case .review: return "ask"
        case .acceptEdits: return "accept-edits"
        case .auto: return "bypass"
        }
    }

    /// The preference the chip is stored in. A constant because it has two
    /// readers now — the panel's own `@AppStorage` and the phone bridge,
    /// which inherits this setting for a phone-driven turn. As two string
    /// literals, renaming the key on one side would leave the other reading a
    /// key that does not exist: the bridge would silently fall back to
    /// `manual` and execution from the phone would stop working, with nothing
    /// to see but turns that park.
    static let defaultsKey = "codeAssist.editMode"
}
