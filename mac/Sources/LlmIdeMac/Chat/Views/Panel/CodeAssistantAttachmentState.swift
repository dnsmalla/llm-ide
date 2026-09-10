import Foundation

/// Attachment/skill state for `CodeAssistantPanel` — independent of the
/// composer/session/streaming invariants (see docs/explanation/invariants.md's
/// "macOS Code Assistant panel" section). Cleared by
/// `resetTransientSessionState()` on session switch/create, same as before —
/// this is a plain data container, not a source of the timing guarantees
/// documented there.
@Observable
final class CodeAssistantAttachmentState {
    var attachments: [LlmIdeAPIClient.CodeAttachment] = []
    /// Files modified during this session (for File → PR automation)
    var modifiedFiles: Set<String> = []
    var selectedSkills: [CodeAssistantPanel.InvokedSkill] = []
}
