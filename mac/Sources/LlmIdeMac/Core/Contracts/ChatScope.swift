import Foundation

/// Which sidebar section a chat belongs to. A section can own many chats;
/// `ChatSessionStore.list(for:)` filters the UUID session files down to
/// this scope. Add a case when a new section gets chat.
///
/// A cross-feature value, hence Core/Contracts: Chat persists and routes by
/// it, but Shell, Mobile Control, Generation and Core's own notification
/// payloads (`PendingApprovalReveal`) name it too. The mapping to a sidebar
/// section (`shellSection`) names a Shell type, so it lives in Shell as an
/// extension (`Shell/ChatScope+Shell.swift`) rather than here.
enum ChatScope: String, Codable, CaseIterable {
    case explorer, conflicts, visual, docGen
    // `quick` is the menu-bar / LLM Chat sheet / iPhone conversation — one shared
    // session, distinct from the panel scopes so a quick question does not land in
    // the user's working chat.
    case quick
}
