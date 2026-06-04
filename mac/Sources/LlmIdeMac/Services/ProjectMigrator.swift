import Foundation
import os.log

/// One-shot importer that walks legacy SavedGitLab/GitHubRepo arrays
/// (where each has a localPath) and registers each as a Project via
/// ProjectStore. The most-recently-active becomes the new
/// activeProject. Records its own completion in a sidecar file so a
/// second invocation is a no-op.
@MainActor
final class ProjectMigrator {

    struct Result {
        let imported: Int
        let alreadyCompleted: Bool
    }

    private let store: ProjectStore
    private let completionMarker: URL
    private let log = Logger(subsystem: "com.llmide.macapp", category: "ProjectMigrator")

    init(store: ProjectStore,
         markerDirectory: URL? = nil) {
        self.store = store
        let dir = markerDirectory ?? Self.defaultMarkerDirectory()
        self.completionMarker = dir.appendingPathComponent(".project-migration-complete")
    }

    private static func defaultMarkerDirectory() -> URL {
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support")
        return appSupport.appendingPathComponent("LLM IDE")
    }

    func runOnce(gitLab: [SavedGitLabProject],
                 gitHub: [SavedGitHubRepo]) -> Result {
        if FileManager.default.fileExists(atPath: completionMarker.path) {
            return Result(imported: 0, alreadyCompleted: true)
        }

        var imported = 0
        var preferredActivePath: String?

        for p in gitLab {
            guard let path = p.localPath, !path.isEmpty else { continue }
            do {
                try store.openFolder(at: URL(fileURLWithPath: path))
                imported += 1
                if p.isActive { preferredActivePath = path }
            } catch {
                log.error("gitlab '\(p.displayName, privacy: .public)' failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        for r in gitHub {
            guard let path = r.localPath, !path.isEmpty else { continue }
            do {
                try store.openFolder(at: URL(fileURLWithPath: path))
                imported += 1
                if r.isActive && preferredActivePath == nil {
                    preferredActivePath = path
                }
            } catch {
                log.error("github '\(r.displayName, privacy: .public)' failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        // The active winner is reopened LAST so it ends up as the
        // activeProject (openFolder sets it).
        if let p = preferredActivePath {
            try? store.openFolder(at: URL(fileURLWithPath: p))
        }

        let hadInputs = !gitLab.isEmpty || !gitHub.isEmpty
        let allFailed = hadInputs && imported == 0
        if !allFailed {
            do {
                try FileManager.default.createDirectory(
                    at: completionMarker.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                let created = FileManager.default.createFile(atPath: completionMarker.path, contents: Data())
                if !created {
                    log.error("ProjectMigrator: createFile returned false at \(self.completionMarker.path, privacy: .public)")
                }
            } catch {
                log.error("ProjectMigrator: marker write failed: \(error.localizedDescription, privacy: .public)")
                // No throw — best-effort. If we couldn't write the marker
                // the worst case is re-running migration next launch, which
                // is idempotent at the per-folder level via store.openFolder.
            }
        }

        return Result(imported: imported, alreadyCompleted: false)
    }
}
