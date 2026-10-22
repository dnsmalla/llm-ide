import Foundation

/// UserDefaults keys for the chat-engine preference, shared by peers that
/// may not name each other: Chat (`AgentV2Selection`, which reads the
/// toggle) and Settings (`ProvidersSettingsSection`, which writes it via
/// `@AppStorage`). A plain string constant in Core is the whole contract —
/// both sides go through `UserDefaults.standard`, so they can never disagree.
enum ChatEnginePreference {
    /// Bool, default true: new chats use the Agent v2 engine. See
    /// `AgentV2Selection` for how the toggle is resolved per turn.
    static let useAgentV2DefaultsKey = "chat.useAgentV2"
}
