import Foundation

/// What the entry gate decided for one send attempt.
public enum QuickChatSendDecision: Equatable {
    /// Go ahead with this trimmed text.
    case proceed(String)
    /// Do nothing, silently — the engine is already busy, or the field is empty.
    case ignore
}

/// The pre-send checks shared by the two quick-chat surfaces (the menu-bar
/// window and the Shell sheet).
///
/// `LlmChatSheet.sendDraft` and `MenuBarChatView.sendDraft` ran the same
/// sequence with the same wording; the menu bar additionally handles slash
/// commands, pending directives and skill ids, which the sheet does not.
/// **Only the common part lives here.** Granting the sheet the menu bar's extra
/// capabilities would be a product change, not a refactor, so the surfaces keep
/// their own bodies around this gate.
///
/// The flow has TWO busy checks and they are not the same:
///
/// 1. this entry gate — returns silently, showing nothing;
/// 2. a re-check after `QuickChatContext.confirmServerSupportsAsk` suspends,
///    which DOES show `busyMessage`, because by then the user's text has been
///    taken out of the field and losing it silently would read as a dead button.
///
/// Only (1) is modelled here; (2) stays at the call site with the async work it
/// guards. Collapsing the two would change behaviour.
///
/// `public` so `chat-contract-lab` can assert it; see `ChatStreamBuffer`.
public struct QuickChatSendPolicy {
    /// Shown by the post-probe re-check. Verbatim from both original copies —
    /// asserted in the lab so a reword cannot silently diverge again.
    public static let busyMessage =
        "Another message is still being answered. Send this one again in a moment."

    public init() {}

    /// The checks that run before any async work: busy first, then emptiness.
    /// Both outcomes are silent, matching the original guards.
    public func entryGate(draft: String, busy: Bool) -> QuickChatSendDecision {
        guard !busy else { return .ignore }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .ignore }
        return .proceed(text)
    }
}
