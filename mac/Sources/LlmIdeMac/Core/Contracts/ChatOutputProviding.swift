import Foundation

/// Read access to what a chat has produced, for features that act on the
/// chat's output (Generation's "Save chat output") without naming Chat's
/// engine types.
///
/// Chat conforms (`ChatEngineOutputProvider`); Shell installs it into
/// `ChatOutputRegistry` at boot (`FeatureCatalog.installChatSeams`).
@MainActor
protocol ChatOutputProviding {
    /// The latest assistant reply in the chat for `scope` that FINISHED
    /// normally, verbatim (not trimmed).
    ///
    /// - Pre: main actor.
    /// - Post: nil when the scope has no assistant reply yet, when the latest
    ///   finished one is empty/whitespace, or when it was stopped or failed
    ///   mid-stream — partial text must never be offered as a complete
    ///   document.
    /// - Reads the SAME conversation the chat panel for `scope` renders, and
    ///   reads it observably: a SwiftUI body calling this re-evaluates when
    ///   that conversation's messages change.
    func latestCompletedAssistantReply(scope: ChatScope, api: LlmIdeAPIClient) -> String?
}

/// Holds the installed `ChatOutputProviding`.
///
/// Contract:
/// - `install(_:)` — Post: replaces any previous provider (last install wins).
/// - `latestCompletedAssistantReply(scope:api:)` — Post: the provider's
///   answer, or nil when nothing is installed (a consumer then simply shows
///   "no reply yet"; it never crashes).
@MainActor
final class ChatOutputRegistry {
    static let shared = ChatOutputRegistry()

    private(set) var provider: (any ChatOutputProviding)?

    /// Internal (not private) so tests can use an isolated instance.
    init() {}

    func install(_ provider: any ChatOutputProviding) {
        self.provider = provider
    }

    func latestCompletedAssistantReply(scope: ChatScope, api: LlmIdeAPIClient) -> String? {
        provider?.latestCompletedAssistantReply(scope: scope, api: api)
    }
}
