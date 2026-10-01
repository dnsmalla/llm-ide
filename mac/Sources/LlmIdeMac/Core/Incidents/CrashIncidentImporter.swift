import Foundation

/// Turns previously-captured crash logs (`CrashReportStore`) into incidents,
/// once per crash file — the same files are rescanned on every launch until
/// `CrashReportStore` dismisses them, so recording must dedupe independently.
public enum CrashIncidentImporter {
    public static let recordedKey = "LLMIDE_SELF_HEAL_RECORDED_CRASHES"

    @MainActor
    public static func importCrashes(_ crashes: [(id: String, contents: String)], defaults: UserDefaults = .standard,
                                     record: (_ message: String, _ stack: String) -> Void) {
        var seen = Set(defaults.stringArray(forKey: recordedKey) ?? [])
        for crash in crashes where !seen.contains(crash.id) {
            let first = crash.contents.split(separator: "\n").first.map(String.init) ?? "Crash"
            record(first, crash.contents)
            seen.insert(crash.id)
        }
        defaults.set(Array(seen.suffix(50)), forKey: recordedKey)
    }
}
