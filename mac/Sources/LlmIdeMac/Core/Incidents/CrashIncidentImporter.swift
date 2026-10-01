import Foundation

/// Turns previously-captured crash logs (`CrashReportStore`) into incidents,
/// once per crash file — the same files are rescanned on every launch until
/// `CrashReportStore` dismisses them, so recording must dedupe independently.
public enum CrashIncidentImporter {
    public static let recordedKey = "LLMIDE_SELF_HEAL_RECORDED_CRASHES"

    @MainActor
    public static func importCrashes(_ crashes: [(id: String, contents: String)], defaults: UserDefaults = .standard,
                                     record: (_ message: String, _ stack: String) -> Void) {
        // Ordered list, not just a Set — Set's hash order is randomized per
        // launch, so truncating a Set to 50 could drop an already-recorded id
        // and re-record it as new. The list preserves recency order instead.
        var recorded = defaults.stringArray(forKey: recordedKey) ?? []
        var seen = Set(recorded)
        for crash in crashes where !seen.contains(crash.id) {
            let first = crash.contents.split(separator: "\n").first.map(String.init) ?? "Crash"
            record(first, crash.contents)
            seen.insert(crash.id)
            recorded.append(crash.id)
        }
        defaults.set(Array(recorded.suffix(50)), forKey: recordedKey)
    }
}
