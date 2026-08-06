import Foundation
import Observation

/// A crash log file written by `installCrashHandlers()` (LlmIdeMacApp.swift)
/// during a prior launch's uncaught exception or fatal signal.
struct CrashReportFile: Identifiable, Equatable {
    let id: String
    let url: URL
    let capturedAt: Date
}

/// Owns the on-disk `~/Library/Application Support/llm-ide/crashes/`
/// folder — scans it on launch for logs left by a previous crash, and
/// lets the user view/dismiss them. Mirrors `ProjectStore`'s
/// `corruptStateArchivedAt`/`acknowledgeCorruptState` shape (detect an
/// anomaly on launch, surface it once, let the user acknowledge it).
@MainActor
@Observable
final class CrashReportStore {
    /// Oldest files beyond this count are dropped silently on scan —
    /// crashes are rare enough that this should never really bind, it's
    /// just a bound against unbounded growth if something crash-loops.
    private static let maxRetained = 5

    private(set) var pendingCrashes: [CrashReportFile] = []

    private let directory: URL
    private let fileManager: FileManager

    init(directory: URL? = nil, fileManager: FileManager = .default) {
        self.directory = directory
            ?? AppIdentity.applicationSupportRoot().appendingPathComponent("crashes", isDirectory: true)
        self.fileManager = fileManager
    }

    /// Scan for crash logs left by a previous launch. Call once on
    /// startup (AppShell.onAppear) — cheap, a handful of small files at most.
    func scanForPendingCrashes() {
        guard let entries = try? fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]) else {
            pendingCrashes = []
            return
        }
        let files = entries
            .filter { $0.pathExtension == "log" }
            .compactMap { url -> CrashReportFile? in
                let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                    .contentModificationDate ?? Date()
                return CrashReportFile(id: url.lastPathComponent, url: url, capturedAt: date)
            }
            .sorted { $0.capturedAt > $1.capturedAt }

        // Drop the oldest beyond the cap so a crash loop can't leave an
        // unbounded number of files sitting on disk unacknowledged.
        if files.count > Self.maxRetained {
            for stale in files[Self.maxRetained...] {
                try? fileManager.removeItem(at: stale.url)
            }
        }
        pendingCrashes = Array(files.prefix(Self.maxRetained))
    }

    /// Raw text of a crash log, for the detail sheet.
    func contents(of file: CrashReportFile) -> String {
        (try? String(contentsOf: file.url, encoding: .utf8)) ?? "(could not read crash log)"
    }

    /// Acknowledge everything currently pending — deletes the files. The
    /// OS's own crash reporter (~/Library/Logs/DiagnosticReports/) and
    /// Console.app both keep their own independent copy; this store only
    /// exists to surface "you crashed last time" once, not to be the
    /// permanent record.
    func dismissAll() {
        for file in pendingCrashes {
            try? fileManager.removeItem(at: file.url)
        }
        pendingCrashes = []
    }
}
