import Foundation

// MARK: — Shared chat value types

/// One entry in the chat transcript. Owned by `LlmIdeChatStore`, rendered by `ChatBubble`.
public struct ChatMessage: Identifiable, Equatable {
    /// STABLE across a history reload. The id used to be a fresh `UUID()` per
    /// instance, and `loadSharedHistory()` replaces the whole array after every
    /// completed reply — so identical content got a new identity each time and
    /// SwiftUI tore down and rebuilt the entire transcript, losing the scroll
    /// anchor. Server-derived turns key on (index, role, text); locally minted
    /// ones keep a UUID, which is stable for their lifetime.
    public let id: String
    public let role: Role
    public var text: String
    /// Optional image the user attached (shown as a thumbnail in the bubble).
    public var imageData: Data? = nil

    public enum Role { case user, assistant }

    public init(role: Role, text: String, imageData: Data? = nil) {
        self.id = UUID().uuidString
        self.role = role
        self.text = text
        self.imageData = imageData
    }

    /// A turn restored from the server transcript. `index` disambiguates two
    /// identical messages in one conversation.
    public init(historyIndex index: Int, role: Role, text: String) {
        self.id = "h\(index):\(role == .assistant ? "a" : "u"):\(text.hashValue)"
        self.role = role
        self.text = text
        self.imageData = nil
    }
}

// MARK: — Streaming-chat helpers

/// Append the user turn + an empty assistant placeholder, and mint a commandId
/// into the store's id set. Returns the commandId.
@discardableResult
public func mintStreamingTurn(
    messages: inout [ChatMessage],
    commandIds: inout Set<String>,
    userText: String,
    imageData: Data? = nil
) -> String {
    messages.append(ChatMessage(role: .user, text: userText, imageData: imageData))
    messages.append(ChatMessage(role: .assistant, text: ""))
    let id = UUID().uuidString
    commandIds.insert(id)
    return id
}

public func appendToLastAssistant(_ list: inout [ChatMessage], _ chunk: String) {
    if let idx = list.lastIndex(where: { $0.role == .assistant }) {
        list[idx].text += chunk
    } else {
        list.append(ChatMessage(role: .assistant, text: chunk))
    }
}

public func removeTrailingEmptyAssistant(_ list: inout [ChatMessage]) {
    if let last = list.last, last.role == .assistant, last.text.isEmpty {
        list.removeLast()
    }
}

