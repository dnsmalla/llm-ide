import Foundation

/// Chat's answer to `ChatOutputProviding`: reads the shared `ChatEngine` the
/// panel for a scope renders. Installed by Shell
/// (`FeatureCatalog.installChatSeams`) so Generation's "Save chat output" row
/// can read the reply without naming `ChatEngine` / `ChatEngineRegistry`.
@MainActor
struct ChatEngineOutputProvider: ChatOutputProviding {
    /// Same lookup the chat panel uses (`engine(for:api:)`), so this always
    /// reads the conversation actually on screen for that scope. `messages` is
    /// an `@Observable` read, so a SwiftUI body that calls this re-evaluates
    /// whenever the conversation changes, same as the panel itself.
    ///
    /// Requires `status == .done` rather than merely excluding `.streaming`:
    /// `ChatMessage.Status` also has `.stopped` (the user pressed Stop
    /// mid-reply — `ChatEngine.finishStreamingTurn` keeps the partial
    /// streamed text in `content`, only the wire encoder adds a "(stopped)"
    /// marker) and `.failed` (a turn that errored mid-stream, same partial
    /// `content` left in place, with the error in `metadata.failedError`).
    /// Both hold genuinely incomplete text — saving one under the normal
    /// "Save chat output" label would write a truncated document with no
    /// indication to the user that it isn't what they think it is.
    ///
    /// Broken into explicit, separately-typed steps (find the message, then
    /// trim its content, then decide) rather than one chained guard: a
    /// closure predicate combined with `.trimmingCharacters(...).isEmpty`
    /// negation in a single condition is the same type-checker blowup shape
    /// `GenerationEditorPanel.generatingTitle` was pulled out to avoid.
    func latestCompletedAssistantReply(scope: ChatScope, api: LlmIdeAPIClient) -> String? {
        let engine = ChatEngineRegistry.shared.engine(for: scope, api: api)
        let doneMessages = engine.messages.filter { message -> Bool in
            message.role == .assistant && message.status == .done
        }
        guard let last = doneMessages.last else { return nil }
        let trimmed: String = last.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return last.content
    }
}
