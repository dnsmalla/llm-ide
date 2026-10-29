import Foundation

/// State behind the "chats kept on the server" list in Settings → Chat archive. Each row offers
/// "Archive as is" (accept an incomplete archive: the copy on this Mac has messages the live store dropped) and
/// "Keep on server" (stop listing it; the rows stay). Nothing here deletes without the user's confirmation, and a
/// result that is not a success keeps the row and says why.
@MainActor
final class ChatArchiveAttentionModel: ObservableObject {
    @Published private(set) var items: [ChatArchiveAttentionItem] = []
    /// The row waiting for the "Archive as is" confirmation.
    @Published private(set) var confirming: ChatArchiveAttentionItem?
    @Published private(set) var busy: Set<String> = []
    @Published private(set) var message: String?

    private let host: ChatArchiveDecisionHosting

    init(host: ChatArchiveDecisionHosting) { self.host = host }

    func reload() async {
        items = await host.attentionItems()
        // A row that vanished (archived by a sweep meanwhile) cannot stay in the confirmation.
        if let c = confirming, !items.contains(where: { $0.serverId == c.serverId }) { confirming = nil }
    }

    /// Step one of "Archive as is": ask for confirmation. Only an incomplete archive can be accepted.
    func requestArchiveAsIs(_ id: String) {
        guard let item = items.first(where: { $0.serverId == id }), item.canArchiveAsIs, !busy.contains(id) else { return }
        confirming = item
    }

    func cancelConfirm() { confirming = nil }

    /// Step two, after the user confirmed.
    func confirmArchiveAsIs() async {
        guard let item = confirming else { return }
        confirming = nil
        guard busy.insert(item.serverId).inserted else { return }
        message = nil
        let outcome = await host.acceptIncompleteArchive(item.serverId)
        busy.remove(item.serverId)
        message = ChatArchiveAttentionWording.result(outcome, title: item.title)
        await reload()
    }

    func keepOnServer(_ id: String) async {
        guard !busy.contains(id) else { return }
        await host.dismissAttention(id)
        message = nil
        await reload()
    }
}

enum ChatArchiveAttentionWording {
    static func displayTitle(_ item: ChatArchiveAttentionItem) -> String {
        item.title.isEmpty ? "Untitled chat" : item.title
    }

    static func counts(_ item: ChatArchiveAttentionItem) -> String {
        let server = "\(item.serverMessages) message\(item.serverMessages == 1 ? "" : "s") on the server"
        if let mac = item.macMessages { return "\(server), \(mac) in the file on this Mac" }
        return server
    }

    static func reason(_ item: ChatArchiveAttentionItem) -> String {
        switch item.reason {
        case let .incomplete(pruned, truncated):
            var parts: [String] = []
            if pruned > 0 { parts.append("\(pruned) older message\(pruned == 1 ? " was" : "s were") dropped") }
            if truncated > 0 { parts.append("\(truncated) long message\(truncated == 1 ? " was" : "s were") cut short") }
            let detail = parts.isEmpty ? "some messages were dropped or cut short" : parts.joined(separator: " and ")
            return "Incomplete: \(detail) before they could be archived."
        case .conflict:
            return "A file on this Mac with the same id differs from the server's copy, so neither is overwritten."
        }
    }

    static let confirmMessage = "This saves the copy on this Mac with the dropped or shortened messages missing, then removes the server's copy. The missing parts cannot be recovered afterwards."

    static func result(_ outcome: ChatArchiveOutcome, title: String) -> String? {
        switch outcome {
        case .committed, .alreadyArchived:
            return nil
        case .shadowWritten:
            return "Shadow mode saved the copy on this Mac and left the server's copy in place."
        case .goneOnServer:
            return "That chat is no longer on the server."
        case .userChanged, .failed("signed out"):
            return "Sign in again to archive this chat."
        case let .failed(why):
            return "Could not archive it: \(why). It is still kept on the server."
        case .skippedBusy:
            return "That chat is being archived right now. Try again in a moment."
        default:
            return "It was not archived. It is still kept on the server."
        }
    }
}
