import Foundation

public enum IncidentRedactor {
    public static let maxMessage = 2000
    public static let maxStack = 8000

    private static let keyValue = try! NSRegularExpression(
        pattern: #"(?i)\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|passwd))(["']?\s*[=:]\s*["']?)[^\s&"',;}]+"#)
    private static let jwt = try! NSRegularExpression(pattern: #"eyJ[\w-]+\.[\w-]+\.[\w-]+"#)
    private static let email = try! NSRegularExpression(
        pattern: #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#)

    public static func redact(_ text: String, limit: Int, home: String = NSHomeDirectory()) -> String {
        var out = SecretRedactor.redact(text)
        out = replace(jwt, in: out, with: "[REDACTED]")
        out = replace(keyValue, in: out, with: "$1$2[REDACTED]")
        out = replace(email, in: out, with: "[EMAIL]")
        if !home.isEmpty { out = out.replacingOccurrences(of: home, with: "~") }
        guard out.count > limit else { return out }
        return String(out.prefix(limit)) + "…[truncated]"
    }

    private static func replace(_ re: NSRegularExpression, in text: String, with template: String) -> String {
        re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}
