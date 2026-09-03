import SwiftUI

/// Pure decision core for `MonacoEditorView`'s `MonacoHost.onMessage`
/// callback — pulled out so it's unit-testable without a live `WKWebView`,
/// mirroring `WorkspaceRoot.pickGitRoot`'s "pure core, separated for tests"
/// pattern. `MonacoEditorView` applies the returned `Effect`; this function
/// touches no state itself.
enum MonacoEditorMessageHandler {
    enum Effect: Equatable {
        case updateContent(String)
        case requestSave
        /// `.ready` (handled by `MonacoHost.onReady`, not here),
        /// `.cursorMoved`/`.gutterAction`/`.diffHunkAction` (P2/P3) — no
        /// action in P1. Kept as an explicit case, not an unhandled default,
        /// so the switch below stays exhaustive as new message cases arrive.
        case none
    }

    static func effect(for message: MonacoOutboundMessage) -> Effect {
        switch message {
        case .contentChanged(let text):
            return .updateContent(text)
        case .requestSave:
            return .requestSave
        case .ready, .cursorMoved, .gutterAction, .diffHunkAction:
            return .none
        }
    }
}
