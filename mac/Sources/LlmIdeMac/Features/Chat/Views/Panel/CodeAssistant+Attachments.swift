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
        do {
            let data = try Data(contentsOf: url)
            let ext = url.pathExtension.lowercased()

            // Known binary types that we support
            let binaryTypes = ["pdf", "png", "jpg", "jpeg", "gif", "webp"]

            if binaryTypes.contains(ext) {
                // Encode binary files as base64 with mime type prefix
                let mime: String
                switch ext {
                case "pdf": mime = "application/pdf"
                case "png": mime = "image/png"
                case "jpg", "jpeg": mime = "image/jpeg"
                case "gif": mime = "image/gif"
                case "webp": mime = "image/webp"
                default: mime = "application/octet-stream"
                }

                let base64Content = "[binary:\(mime)]\n" + data.base64EncodedString()
                attachmentState.attachments.append(LlmIdeAPIClient.CodeAttachment(path: path, content: base64Content))
                return .added
            }

            // Text files: reject obviously-binary files (≥1% NUL bytes in the first 4K).
            // An empty file has no bytes to probe — it's valid (empty) text, so
            // don't let the `0 >= 0` ratio misclassify it as binary.
            let probe = data.prefix(4096)
            if !probe.isEmpty {
                let nulCount = probe.reduce(into: 0) { acc, b in if b == 0 { acc += 1 } }
                if nulCount * 100 >= probe.count { return .notText }
            }
            guard let text = String(data: data, encoding: .utf8) else { return .notText }
            attachmentState.attachments.append(LlmIdeAPIClient.CodeAttachment(path: path, content: text))
            return .added
        } catch {
            return .unreadable
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
