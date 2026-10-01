import Foundation

public enum SelfHealSettings {
    public static let enabledKey = "LLMIDE_SELF_HEAL_ENABLED"
    public static let maxPerRunKey = "LLMIDE_SELF_HEAL_MAX_PER_RUN"

    public static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? true
    }

    public static func maxPerRun(_ defaults: UserDefaults = .standard) -> Int {
        let value = defaults.integer(forKey: maxPerRunKey)
        return value > 0 ? min(value, 20) : 5
    }
}
