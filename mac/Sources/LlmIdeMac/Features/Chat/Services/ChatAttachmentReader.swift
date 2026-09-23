import Foundation
import PDFKit

/// Turns a file on disk into the text a chat attachment carries.
///
/// Pure (no panel state) so its rules are testable. They exist because of
/// what the server does with an attachment: only `[binary:image/*]` content
/// becomes an image block for the model; everything else is treated as TEXT
/// and cut at 80K characters (`prompt-framing.mjs` `selectAttachments`).
enum ChatAttachmentReader {
    enum Result: Equatable {
        /// The attachment content to send.
        case content(String)
        /// Refused, with the reason to show the user.
        case refused(String)
        /// Neither text nor a supported image.
        case notText
        case unreadable
    }

    /// Largest file read at all. Checked BEFORE loading: the read used to be
    /// an unbounded `Data(contentsOf:)` on the main thread — dropping a
    /// 500 MB log froze the UI and held several times its size in memory,
    /// only for the server to keep 80K characters of it.
    static let maxFileBytes = 25 * 1024 * 1024
    /// The server drops an image whose base64 exceeds 6,000,000 characters
    /// (`MAX_IMAGE_BASE64_CHARS`), i.e. ~4.5 MB raw — silently, until now.
    static let maxImageBytes = 4_500_000

    static let imageMimeTypes = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                                 "gif": "image/gif", "webp": "image/webp"]

    static func read(_ url: URL) -> Result {
        let name = url.lastPathComponent
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > maxFileBytes {
            return .refused("\u{201C}\(name)\u{201D} is \(formatted(size)) — too large to attach (limit \(formatted(maxFileBytes))).")
        }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return .unreadable }
        let ext = url.pathExtension.lowercased()

        if let mime = imageMimeTypes[ext] {
            guard data.count <= maxImageBytes else {
                return .refused("\u{201C}\(name)\u{201D} is \(formatted(data.count)) — images over \(formatted(maxImageBytes)) can't be sent to the model.")
            }
            return .content("[binary:\(mime)]\n" + data.base64EncodedString())
        }

        if ext == "pdf" {
            // Its TEXT, not its bytes: a PDF sent as base64 reached the model
            // as 80K characters of meaningless base64 (~60K tokens spent).
            guard let text = PDFDocument(data: data)?.string?
                .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                return .refused("\u{201C}\(name)\u{201D} has no text layer (a scanned PDF?) — nothing to attach.")
            }
            return .content("[text extracted from PDF: \(name)]\n" + text)
        }

        // Obviously binary: ≥1% NUL bytes in the first 4K. An empty file has
        // nothing to probe and is valid (empty) text.
        let probe = data.prefix(4096)
        if !probe.isEmpty {
            let nulCount = probe.reduce(into: 0) { acc, b in if b == 0 { acc += 1 } }
            if nulCount * 100 >= probe.count && !hasUTF16BOM(data) { return .notText }
        }
        guard let text = decodeText(data) else { return .notText }
        return .content(text)
    }

    /// UTF-8 first; then UTF-16 when it carries a BOM, then the Japanese
    /// encodings a text file here is most likely to be in. Only UTF-8 was
    /// tried before, so a Shift-JIS source file was refused as "not text".
    static func decodeText(_ data: Data) -> String? {
        if let s = String(data: data, encoding: .utf8) { return s }
        if hasUTF16BOM(data), let s = String(data: data, encoding: .utf16) { return s }
        for encoding: String.Encoding in [.shiftJIS, .japaneseEUC] {
            if let s = String(data: data, encoding: encoding) { return s }
        }
        return nil
    }

    private static func hasUTF16BOM(_ data: Data) -> Bool {
        data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF])
    }

    private static func formatted(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
