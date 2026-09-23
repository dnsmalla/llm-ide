import SwiftUI

extension CodeAssistantPanel {

    // MARK: - File attachment

    /// Attaches a file's text content. Returns why it did or didn't so
    /// single-file callers can surface a notice instead of dropping
    /// silently (the bug behind the "Visual" page ignoring images).
    /// Now supports binary files (PDF, images) via base64 encoding.
    @discardableResult
    func addFile(url: URL) -> AttachOutcome {
        let path = displayPath(url)
        // Idempotent — re-adding the same file does nothing.
        if attachmentState.attachments.contains(where: { $0.path == path }) { return .duplicate }
        // The rules (size caps, PDF text extraction, encodings) live in
        // `ChatAttachmentReader` so they are testable without a panel.
        switch ChatAttachmentReader.read(url) {
        case .content(let content):
            attachmentState.attachments.append(LlmIdeAPIClient.CodeAttachment(path: path, content: content))
            return .added
        case .refused(let reason): return .refused(reason)
        case .notText: return .notText
        case .unreadable: return .unreadable
        }
    }

    /// Attach an image pasted into the composer (⌘V of a screenshot, or of a
    /// picture copied from anywhere else).
    ///
    /// Same `[binary:<mime>]` encoding `addFile` gives an image on disk, so it
    /// travels the one attachment path — but with no file behind it, so the
    /// name is synthesized and numbered per chat: the chip needs a label, the
    /// server names the image to the model by this path, and two screenshots
    /// in one turn have to be distinguishable ("the first one").
    ///
    /// Returns false when the bytes aren't usable, so the caller can fall back
    /// to a normal paste rather than swallowing the keystroke.
    @discardableResult
    func attachPastedImage(_ data: Data, mediaType: String) -> Bool {
        guard !data.isEmpty else { return false }
        let ext: String
        switch mediaType {
        case "image/png": ext = "png"
        case "image/jpeg": ext = "jpg"
        case "image/gif": ext = "gif"
        case "image/webp": ext = "webp"
        default: return false
        }
        // Numbered from 1 for each message — chips are one-shot (cleared on
        // send), and a counter that kept climbing across a conversation would
        // label a lone screenshot "Pasted image 7".
        //
        // Taken by SEARCHING for a free name rather than counting what is
        // staged: with a count, pasting two, deleting the first and pasting
        // again re-issues "Pasted image 2". Attachments are keyed by path
        // everywhere downstream — `addFile`'s duplicate check, the server's
        // own `selectAttachments` (which skips a path it has already seen) —
        // so that duplicate would not be a clash the user could see, it would
        // be the second screenshot silently never reaching the model.
        var n = 1
        var path = "\(Self.pastedImagePrefix)\(n).\(ext)"
        while attachmentState.attachments.contains(where: { $0.path == path }) {
            n += 1
            path = "\(Self.pastedImagePrefix)\(n).\(ext)"
        }
        attachmentState.attachments.append(LlmIdeAPIClient.CodeAttachment(
            path: path,
            content: "[binary:\(mediaType)]\n" + data.base64EncodedString()))
        return true
    }

    /// Label prefix for a pasted image. Also how `attachPastedImage` counts
    /// the ones already staged, so it stays a single definition.
    static var pastedImagePrefix: String { "Pasted image " }

    /// Replace the home prefix with `~/` for the chip label / prompt.
    /// Prevents the user's username leaking unnecessarily into LLM
    /// logs upstream.
    func displayPath(_ url: URL) -> String {
        PathUtils.homeRelative(url.path)
    }
}
