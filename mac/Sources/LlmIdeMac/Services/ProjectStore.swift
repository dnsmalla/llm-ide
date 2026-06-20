import Foundation
import Combine
import os.log

// Notification.Name.activeProjectChanged is declared in
// Services/NotificationNames.swift.

/// App-wide recents + active project record. Kept in
/// `<stateDirectory>/projects.json`. The active Project is fully
/// hydrated from its own `<folder>/system/project.json` on demand.
@MainActor
final class ProjectStore: ObservableObject {

    struct ActiveProject: Equatable {
        let bundle: Project       // the loaded contents
        let localPath: String     // resolved folder URL.path
    }

    struct RecentEntry: Codable, Equatable, Identifiable {
        let id: String            // project id
        let path: String
        let displayName: String
        let lastOpenedAt: Date
    }

    @Published private(set) var activeProject: ActiveProject?
    @Published private(set) var recents: [RecentEntry] = []
    /// True while an async export is running — drives the close-progress UI.
    @Published private(set) var isExporting = false
    /// Set when a corrupt projects.json was archived on launch; the Welcome
    /// screen shows a one-time notice so the reset isn't silent. nil = healthy.
    @Published private(set) var corruptStateArchivedAt: URL?

    /// Dismiss the corrupt-state notice once the user has seen it.
    func acknowledgeCorruptState() { corruptStateArchivedAt = nil }

    private let stateDirectory: URL
    private let defaults: ProjectSettings
    private let stateFile: URL
    private static let recentsCap = 20
    private let log = Logger(subsystem: "com.llmide.macapp", category: "ProjectStore")

    /// Injected by `LlmIdeMacApp.init()` so the exporter can call
    /// authenticated endpoints.  Strong reference — both the API client and
    /// ProjectStore are owned by the App struct with identical lifetimes,
    /// so there is no retain-cycle concern.
    var _apiClient: LlmIdeAPIClient?

    init(stateDirectory: URL,
         defaults: ProjectSettings = ProjectStore.fallbackDefaults) {
        self.stateDirectory = stateDirectory
        self.defaults = defaults
        self.stateFile = stateDirectory.appendingPathComponent("projects.json")
        loadStateFromDisk()
    }

    /// Defaults used when no AppConfig is supplied (test paths).
    nonisolated static let fallbackDefaults = ProjectSettings(
        language: "en", activeCLI: "claudeCode", linkedRepo: nil,
        notesFolderRelative: nil, enabledPlugins: [],
        regressionLookbackCount: 5,
        agentPersona: nil, docTemplatesActive: [])

    // MARK: - Public API

    func openFolder(at url: URL) throws {
        // Normalise the URL so case-insensitive filesystem differences
        // (HFS+/APFS) don't create duplicate recents for the same folder.
        let url = url.standardizedFileURL

        // Guard against opening arbitrary non-project folders.
        // Throws ProjectStoreError.invalidFolderStructure when the folder
        // is non-empty and missing the required LLM IDE sub-folder tree.
        try ProjectScaffolder.validate(at: url)

        let projectJSON = url.appendingPathComponent("system/project.json")
        let project: Project
        if FileManager.default.fileExists(atPath: projectJSON.path) {
            let data = try Data(contentsOf: projectJSON)
            project = try Project.fromJSON(data)
        } else {
            project = createFromDefaults(folder: url)
            try writeProjectJSON(project, to: projectJSON)
        }

        // Scaffold the canonical folder tree (idempotent — only creates
        // what is missing, so re-opening an existing project is safe).
        do {
            try ProjectScaffolder.scaffold(at: url, project: project)
        } catch {
            // Scaffolding failure is non-fatal — the project still opens.
            // Log the error so it appears in Console.app for diagnostics.
            log.error("scaffold failed at \(url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }

        // ── Single-source-of-truth sync ───────────────────────────────
        // NotesFolderConfig (UserDefaults) must reflect the project's
        // meetings/ directory BEFORE activeProject is published so that
        // AppEnvironment (constructed by AppShell on first render of
        // existingShellContent) reads the correct path.  For project
        // switches, AppShell observes .notesFolderChanged and rebuilds
        // AppEnvironment after this call.
        let sourceFolder = url.appendingPathComponent("source", isDirectory: true)
        try? NotesFolderConfig().setFolderFromPath(sourceFolder)

        activeProject = ActiveProject(bundle: project, localPath: url.path)
        bumpRecent(id: project.id, path: url.path, displayName: project.displayName)
        try persistState()
        NotificationCenter.default.post(name: .activeProjectChanged, object: nil)
        // Rebuild AppEnvironment (FolderIndexer + MeetingIndex SQLite)
        // so the rest of the app immediately uses the project's folder.
        NotificationCenter.default.post(name: .notesFolderChanged, object: nil)
    }

    /// Adopt `folderURL` as a LLM IDE project: write `system/project.json`
    /// and the canonical folder tree if they don't already exist. Idempotent —
    /// safe on an existing project (returns its bundle unchanged).
    ///
    /// Unlike `openFolder`, this deliberately does NOT run
    /// `ProjectScaffolder.validate` first, so it can adopt a folder that is
    /// non-empty and lacks the LLM IDE tree — e.g. a freshly-cloned code
    /// repo. After this call the folder passes validation and `openFolder`
    /// succeeds. Does not activate the project or touch recents.
    @discardableResult
    func ensureProjectScaffold(at folderURL: URL) throws -> Project {
        let url = folderURL.standardizedFileURL
        let projectJSON = url.appendingPathComponent("system/project.json")
        let project: Project
        if FileManager.default.fileExists(atPath: projectJSON.path) {
            project = try Project.fromJSON(Data(contentsOf: projectJSON))
        } else {
            project = createFromDefaults(folder: url)
            try writeProjectJSON(project, to: projectJSON)
        }
        // Idempotent; preserves a repo's own README (see ProjectScaffolder).
        try ProjectScaffolder.scaffold(at: url, project: project)
        return project
    }

    func switchTo(recent entry: RecentEntry) throws {
        // Prevent switching while an export is in-flight — the export holds
        // a reference to the current activeProject; switching underneath it
        // would write to the wrong folder.
        guard !isExporting else {
            throw ProjectStoreError.exportInProgress
        }
        try openFolder(at: URL(fileURLWithPath: entry.path))
    }

    /// Immediate close with no data export.  Used for error recovery or when
    /// the caller has already exported (or doesn't need to).
    func closeActive() throws {
        activeProject = nil
        try persistState()
        NotificationCenter.default.post(name: .activeProjectChanged, object: nil)
        // Revert NotesFolderConfig to the app-wide default so the next
        // project open (or a manual folder pick in Settings → Paths) starts
        // from a clean state.  Best-effort — a failure here doesn't block
        // the close or corrupt any data.
        try? NotesFolderConfig().setFolderFromPath(NotesFolderConfig().defaultFolder())
        NotificationCenter.default.post(name: .notesFolderChanged, object: nil)
    }

    /// Professional close: export all KB data to the project folder tree, then
    /// close.  This is the path the UI "Close Project" button calls.
    ///
    /// - Concurrent-call safe: a second call while `isExporting` is true is a
    ///   no-op — the in-flight export will close the project when it finishes.
    /// - Export failures are logged but never block the close — data is always
    ///   safe in the backend SQLite database.
    func closeActiveWithExport() async {
        // Prevent double-close (e.g. rapid button taps, menu + keyboard shortcut).
        guard !isExporting else { return }

        guard let ap = activeProject else {
            try? closeActive()
            return
        }

        // Capture client and folder URL *before* any suspension point so they
        // can't change under us while the export awaits.
        let client    = _apiClient
        let folderURL = URL(fileURLWithPath: ap.localPath)

        if let client {
            isExporting = true
            do {
                let exporter = ProjectExporter()
                let result = try await exporter.export(
                    project:   ap.bundle,
                    folderURL: folderURL,
                    client:    client)
                log.info("project export ok — \(result.meetingsWritten) meetings, \(result.durationMs)ms")
            } catch {
                log.error("project export failed (close will proceed): \(error.localizedDescription, privacy: .public)")
            }
            isExporting = false
        } else {
            log.warning("closeActiveWithExport: _apiClient not set — export skipped")
        }

        try? closeActive()
    }

    /// Export the active project's KB data to its folder tree WITHOUT closing
    /// it.  Useful for periodic backups or an explicit "Export" menu action.
    ///
    /// - Returns: export statistics, or `nil` when no project is active or the
    ///   API client isn't wired.
    /// - Note: concurrent calls are serialised by the `isExporting` guard —
    ///   callers should check `isExporting` before calling.
    @discardableResult
    func exportCurrentProject() async throws -> ProjectExporter.ExportResult? {
        guard !isExporting else { return nil }
        guard let ap = activeProject, let client = _apiClient else { return nil }

        let folderURL = URL(fileURLWithPath: ap.localPath)
        isExporting = true
        defer { isExporting = false }

        let exporter = ProjectExporter()
        let result = try await exporter.export(
            project:   ap.bundle,
            folderURL: folderURL,
            client:    client)
        log.info("manual export ok — \(result.meetingsWritten) meetings")
        return result
    }

    #if DEBUG
    /// Test-only seam to inject an ActiveProject without touching disk.
    /// Used by unit tests that exercise resolveBackendAndProject-style
    /// logic. Don't call from production code.
    func setActiveForTesting(_ active: ActiveProject?) {
        activeProject = active
    }
    #endif

    // MARK: - Internals

    private func createFromDefaults(folder: URL) -> Project {
        Project(
            id: RandomID.generate(),
            displayName: folder.lastPathComponent,
            createdAt: Date(),
            settings: defaults)
    }

    private func bumpRecent(id: String, path: String, displayName: String) {
        var list = recents.filter { $0.id != id }
        list.insert(RecentEntry(id: id, path: path,
                                displayName: displayName,
                                lastOpenedAt: Date()),
                    at: 0)
        if list.count > Self.recentsCap { list = Array(list.prefix(Self.recentsCap)) }
        recents = list
    }

    private func loadStateFromDisk() {
        guard FileManager.default.fileExists(atPath: stateFile.path) else { return }
        do {
            let data = try Data(contentsOf: stateFile)
            let state = try AppJSON.iso8601Decoder.decode(StateFile.self, from: data)
            // Prune any recent whose project.json is no longer readable
            // (folder deleted, permissions revoked). Without this, a stale
            // entry stays in the sidebar forever and a click on it throws.
            let pruned = state.recents.filter { entry in
                let base = URL(fileURLWithPath: entry.path)
                return FileManager.default.fileExists(
                        atPath: base.appendingPathComponent("system/project.json").path)
            }
            recents = pruned
            if let activeId = state.activeId,
               let entry = pruned.first(where: { $0.id == activeId }) {
                _ = rehydrateActive(from: entry)
            }
            // Persist the pruned list so the next launch is consistent. Done
            // outside any throwing context — best-effort.
            do {
                try persistState()
            } catch {
                log.error("Failed to persist pruned project state at \(self.stateFile.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        } catch {
            log.error("Failed to load project state at \(self.stateFile.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            archiveCorruptStateFile()
        }
    }

    private func rehydrateActive(from entry: RecentEntry) -> Bool {
        let projectJSON = URL(fileURLWithPath: entry.path)
            .appendingPathComponent("system/project.json")
        let data: Data
        do {
            data = try Data(contentsOf: projectJSON)
        } catch {
            log.error("Failed to read project bundle at \(projectJSON.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
        let project: Project
        do {
            project = try Project.fromJSON(data)
        } catch {
            log.error("Failed to decode project bundle at \(projectJSON.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
        // Scaffold the canonical folder tree on launch too (idempotent —
        // only creates what's missing). Without this, a project restored on
        // launch never gains newly-added canonical folders (e.g. code/, data/)
        // until the user explicitly re-opens it. Non-fatal on failure.
        do {
            try ProjectScaffolder.scaffold(at: URL(fileURLWithPath: entry.path), project: project)
        } catch {
            log.error("scaffold failed on rehydrate at \(entry.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
        activeProject = ActiveProject(bundle: project, localPath: entry.path)
        // Sync NotesFolderConfig so AppEnvironment (constructed by AppShell
        // on first render) points at this project's source/ folder.
        // No notification needed here — AppShell hasn't subscribed yet.
        let sourceFolder = URL(fileURLWithPath: entry.path)
            .appendingPathComponent("source", isDirectory: true)
        try? NotesFolderConfig().setFolderFromPath(sourceFolder)
        return true
    }

    private func archiveCorruptStateFile() {
        let stamp = Int(Date().timeIntervalSince1970)
        let dst = stateDirectory.appendingPathComponent("projects.corrupt.\(stamp).json")
        do {
            try FileManager.default.moveItem(at: stateFile, to: dst)
            // Surface it so the UI can tell the user their recents list was
            // reset (and where the unparseable file was archived) instead of
            // it vanishing silently.
            corruptStateArchivedAt = dst
        } catch {
            log.error("Failed to archive corrupt state file from \(self.stateFile.path, privacy: .public) to \(dst.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func persistState() throws {
        let state = StateFile(
            schemaVersion: 1,
            activeId: activeProject?.bundle.id,
            recents: recents)
        try FileManager.default.createDirectory(
            at: stateDirectory, withIntermediateDirectories: true)
        let data = try AppJSON.iso8601Encoder.encode(state)
        // .atomic writes to a tmp file then renames over — same
        // semantics as our previous tmp+replaceItemAt dance, but
        // works whether the destination exists or not.
        try data.write(to: stateFile, options: .atomic)
    }

    private func writeProjectJSON(_ project: Project, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let data = try project.toJSON()
        try data.write(to: url, options: .atomic)
    }

    struct StateFile: Codable {
        let schemaVersion: Int
        let activeId: String?
        let recents: [RecentEntry]
    }
}

// MARK: - Errors

enum ProjectStoreError: LocalizedError {
    case exportInProgress
    case invalidFolderStructure(String)   // associated value = folder name

    var errorDescription: String? {
        switch self {
        case .exportInProgress:
            return "Cannot switch projects while an export is in progress. Please wait for the export to finish."
        case .invalidFolderStructure(let name):
            return """
                "\(name)" is not a LLM IDE project.

                A valid project folder must contain meetings/, notes/, and plans/ sub-folders, \
                or have been created by LLM IDE. \
                Select an existing LLM IDE project folder, or choose an empty folder to start a new project.
                """
        }
    }
}

enum RandomID {
    /// Time-prefixed random identifier. NOT a ULID — no monotonic
    /// ordering guarantee. Used purely for uniqueness; recents are
    /// sorted by lastOpenedAt: Date, not by id.
    static func generate() -> String {
        let ts = UInt64(Date().timeIntervalSince1970 * 1000)
        var bytes = [UInt8](repeating: 0, count: 10)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let tsHex = String(ts, radix: 32, uppercase: false)
        let randHex = bytes.map { String(format: "%02x", $0) }.joined()
        return "\(tsHex)\(randHex)"
    }
}
