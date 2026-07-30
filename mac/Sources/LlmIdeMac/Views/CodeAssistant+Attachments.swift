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
        if attachments.contains(where: { $0.path == path }) { return .duplicate }
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
                attachments.append(LlmIdeAPIClient.CodeAttachment(path: path, content: base64Content))
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
            attachments.append(LlmIdeAPIClient.CodeAttachment(path: path, content: text))
            return .added
        } catch {
            return .unreadable
        }
    }

    /// Replace the home prefix with `~/` for the chip label / prompt.
    /// Prevents the user's username leaking unnecessarily into LLM
    /// logs upstream.
    func displayPath(_ url: URL) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let p = url.path
        if p.hasPrefix(home) { return "~" + p.dropFirst(home.count) }
        return p
    }
}
