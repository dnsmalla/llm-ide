import Foundation

/// Display rules for the composer's context meter, kept pure so
/// chat-contract-lab can pin them. Names and kinds are the SDK's own — no
/// table here — so a category a newer SDK adds is listed as it arrives.
public enum ContextUsagePresentation {
    /// From this percentage the meter switches to the theme's warning colour.
    public static let warningPercentage = 80

    public static func isWarning(_ u: AgentV2ContextUsage) -> Bool {
        u.percentage >= warningPercentage
    }

    public static func percentLabel(_ u: AgentV2ContextUsage) -> String {
        "\(u.percentage)%"
    }

    public static func tokensLabel(_ u: AgentV2ContextUsage) -> String {
        "\(grouped(u.totalTokens)) / \(grouped(u.maxTokens)) tokens"
    }

    /// "used" rows first, then the rest (free space, compaction buffer,
    /// deferred), each group in the SDK's own order.
    public static func rows(_ u: AgentV2ContextUsage)
        -> (used: [AgentV2ContextUsage.Category], other: [AgentV2ContextUsage.Category]) {
        (u.categories.filter { $0.kind == "used" }, u.categories.filter { $0.kind != "used" })
    }

    /// The category's share of the window, one decimal ("0.2%").
    public static func share(_ c: AgentV2ContextUsage.Category, of u: AgentV2ContextUsage) -> String {
        guard u.maxTokens > 0 else { return "–" }
        return String(format: "%.1f%%", Double(c.tokens) / Double(u.maxTokens) * 100)
    }

    private static func grouped(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.groupingSeparator = ","
        f.usesGroupingSeparator = true
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }
}
