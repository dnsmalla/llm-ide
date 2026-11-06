import Foundation

/// A file attached to a chat message: text extracted on-device (PDF, `.md`, `.txt`), never binary.
public struct ChatFileText: Codable, Equatable {
    public let name: String
    public let text: String
    public init(name: String, text: String) { self.name = name; self.text = text }
}
