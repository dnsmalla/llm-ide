import Foundation

/// Rules that keep environment problems away from the fix agent (and its LLM budget).
public enum IncidentClassifier {
    private static let rules: [(reason: String, needles: [String])] = [
        ("offline", ["appears to be offline", "could not connect to the server", "network connection was lost",
                     "nsurlerrordomain code=-1009", "nsurlerrordomain code=-1004", "the request timed out"]),
        ("auth", ["http 401", "http 403", "status 401", "status 403", "unauthorized", "forbidden", "not signed in"]),
        ("permission", ["operation not permitted", "permission denied", "eperm", "eacces"]),
        ("disk", ["no space left on device", "enospc"]),
        // A loop the USER configured wrongly is not an app bug: nothing in this
        // repository fixes "stage has no command".
        ("configuration", ["has no runnable command", "has no skill chosen", "has no checks configured",
                           "needs a newer version of llm-ide"]),
        ("cancelled", ["request was cancelled", "operation was cancelled", "cancellationerror",
                       "cancelled by user", "user cancelled"]),
    ]

    public static func environmentalReason(message: String) -> String? {
        let text = message.lowercased()
        if text.hasPrefix("usage:") || text.contains("no model matching") { return "usage" }
        return rules.first { rule in rule.needles.contains { text.contains($0) } }?.reason
    }
}
