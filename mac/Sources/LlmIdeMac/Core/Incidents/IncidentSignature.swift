import CryptoKit
import Foundation

public enum IncidentSignature {
    // Order matters: quoted strings and UUIDs before the hex/number rules eat their parts.
    private static let rules: [(NSRegularExpression, String)] = [
        (#""[^"\n]*"|'[^'\n]*'"#, "<str>"),
        (#"\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b"#, "<uuid>"),
        (#"(?<![A-Za-z0-9])(?:~/|/)[^\s"':,()]+"#, "<path>"),
        (#"\b[0-9A-Fa-f]{8,}\b"#, "<hex>"),
        (#"\b\d+(?:\.\d+)?\b"#, "<n>"),
        (#"\s+"#, " "),
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    public static func normalize(_ text: String) -> String {
        var out = text
        for (re, template) in rules {
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out),
                                              withTemplate: template)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func normalizeEndpoint(_ path: String) -> String {
        let bare = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return bare.split(separator: "/", omittingEmptySubsequences: false).map { segment -> String in
            let s = String(segment)
            return (s.contains(where: \.isNumber) || s.count >= 20) ? ":id" : s
        }.joined(separator: "/")
    }

    public static func topOwnFrame(_ stack: String?) -> String? {
        guard let stack else { return nil }
        return stack.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.contains("LlmIdeMac") || $0.contains("extension/") }
    }

    public static func make(source: String, category: String, message: String, stack: String?) -> String {
        let frame = topOwnFrame(stack).map(normalize) ?? ""
        let material = [source, category, normalize(message), frame].joined(separator: "\u{0}")
        return SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}
