import Foundation

/// The single rule for what the Mobile Control log pane may say about a frame.
///
/// The pane is on screen, selectable, and keeps thousands of lines, while a
/// frame can be up to 8 MiB of chat text, file content, diffs or a pairing
/// token. So a frame is described by its `type` discriminator and byte size
/// ONLY — never by any slice of its content. A 60-100 character "preview"
/// still leaked the start of every chat message and file, and a frame with no
/// `type` used to be appended whole.
enum MobileLogPolicy {
    /// Longest `type` label shown. Real tags are well under this; anything
    /// longer is not a tag, just phone-controlled text.
    static let maxTypeLabel = 48
    /// Hard cap on any single log line, whatever produced it — a backstop so
    /// one oversized message (an error description, a path) can't grow the
    /// in-memory log without bound.
    static let maxLineLength = 500

    /// `type='llmide_chat', 1234 bytes`, or `no type, 1234 bytes`.
    ///
    /// Decodes only the `{type}` envelope; the rest of the frame is never read.
    nonisolated static func frameLabel(_ data: Data?) -> String {
        guard let data else { return "no data" }
        struct Envelope: Decodable { let type: String }
        guard let env = try? JSONDecoder().decode(Envelope.self, from: data) else {
            return "no type, \(data.count) bytes"
        }
        return "type='\(typeLabel(env.type))', \(data.count) bytes"
    }

    /// A message type made safe to print: only tag-like characters survive,
    /// and the result is capped, so a phone can't smuggle content (or control
    /// characters) into the log through the discriminator itself.
    nonisolated static func typeLabel(_ raw: String) -> String {
        let allowed = raw.unicodeScalars.filter { scalar in
            let value = scalar.value
            return (0x61...0x7A).contains(value) || (0x41...0x5A).contains(value)
                || (0x30...0x39).contains(value) || value == 0x5F || value == 0x2D || value == 0x2E
        }
        let cleaned = String(allowed)
        if cleaned.isEmpty { return "?" }
        if cleaned.count > maxTypeLabel { return String(cleaned.prefix(maxTypeLabel)) + "…" }
        return cleaned
    }

    /// Outbound counterpart of `frameLabel`: the Swift message type and size.
    nonisolated static func outboundLabel(_ message: Any, byteCount: Int) -> String {
        "\(String(describing: type(of: message))), \(byteCount) bytes"
    }

    /// Clamp one log line to `maxLineLength`.
    nonisolated static func capLine(_ text: String) -> String {
        guard text.count > maxLineLength else { return text }
        return String(text.prefix(maxLineLength)) + " …[\(text.count - maxLineLength) chars cut]"
    }
}
