import Foundation

/// The LLM-IDE checkout this build came from, or nil for a distributed build.
/// `LLMIDESourceRoot` is written by `mac/build.sh` as the `mac/` directory.
public enum AppSourceRoot {
    // Computed once: the hot capture path must not stat the filesystem per event.
    public static let gitRoot: URL? = gitRoot(
        plistValue: Bundle.main.object(forInfoDictionaryKey: "LLMIDESourceRoot") as? String,
        fileExists: { FileManager.default.fileExists(atPath: $0) })

    public static func gitRoot(plistValue: String?, fileExists: (String) -> Bool) -> URL? {
        guard let plistValue, !plistValue.isEmpty else { return nil }
        let mac = URL(fileURLWithPath: plistValue).standardizedFileURL
        guard fileExists(mac.appendingPathComponent("Package.swift").path) else { return nil }
        let root = mac.deletingLastPathComponent().standardizedFileURL
        guard fileExists(root.appendingPathComponent(".git").path) else { return nil }
        return root
    }
}
