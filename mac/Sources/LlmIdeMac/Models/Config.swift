import Foundation
import Combine
import os.log

private let configLogger = Logger(subsystem: "com.llmide.macapp", category: "AppConfig")

struct SavedGitLabProject: Codable, Identifiable, Equatable {
    var id: String
    var url: String
    var displayName: String
    var resolvedId: Int?
    var isActive: Bool
    /// Absolute path to the local git clone, set after the user clones the repo.
    var localPath: String?
    /// Default branch (e.g. "main" or "master"), detected on clone.
    var defaultBranch: String?

    init(url: String = "", displayName: String = "", resolvedId: Int? = nil, isActive: Bool = false) {
        self.id = UUID().uuidString
        self.url = url
        self.displayName = displayName
        self.resolvedId = resolvedId
        self.isActive = isActive
    }

    var isCloned: Bool { localPath != nil }
    var localURL: URL? { localPath.map { URL(fileURLWithPath: $0) } }
}

/// User-tunable settings persisted to UserDefaults.
final class AppConfig: ObservableObject {
    static let shared = AppConfig()

    private let defaults: UserDefaults

    @Published var serverURL: String {
        didSet {
            guard AppConfig.isSafeServerURL(serverURL) else {
                serverURL = oldValue   // revert to the previous safe value
                return
            }
            defaults.set(serverURL, forKey: "serverURL")
        }
    }

    @Published var themeID: String {
        didSet { defaults.set(themeID, forKey: "themeID") }
    }

    /// When true, the menu bar icon enters recording state automatically
    /// once a known meeting app (Zoom, Teams) becomes the frontmost app.
    /// Off by default so first-time users see explicit start/stop.
    @Published var autoCaptureOnMeeting: Bool {
        didSet { defaults.set(autoCaptureOnMeeting, forKey: "autoCaptureOnMeeting") }
    }

    /// Polling interval (ms) for the AX caption readers.  Tradeoff:
    /// shorter is more responsive but burns more CPU walking the
    /// accessibility tree.  Zoom redraws the captions panel every
    /// 200–400 ms, so 250 ms gives us per-frame fidelity without
    /// over-polling.
    @Published var pollIntervalMs: Int {
        didSet { defaults.set(pollIntervalMs, forKey: "pollIntervalMs") }
    }

    /// The active AI CLI tool (raw value of AICliTool).
    @Published var activeCLI: String {
        didSet { defaults.set(activeCLI, forKey: "activeCLI") }
    }

    /// Default model ID for the active CLI, shown in CodeAssistantPanel.
    @Published var defaultModelId: String {
        didSet { defaults.set(defaultModelId, forKey: "defaultModelId") }
    }

    // ── GitLab integration ────────────────────────────────────────────
    /// Personal Access Token with api scope. Stored in Keychain.
    @Published var gitLabToken: String {
        didSet {
            if gitLabToken.isEmpty {
                KeychainStore.deleteGitLabToken(host: gitLabBaseURL)
            } else {
                KeychainStore.saveGitLabToken(gitLabToken, host: gitLabBaseURL)
            }
        }
    }
    /// GitLab instance base URL — defaults to gitlab.com.
    @Published var gitLabBaseURL: String {
        didSet {
            defaults.set(gitLabBaseURL, forKey: "gitLabBaseURL")
            if !gitLabToken.isEmpty {
                KeychainStore.deleteGitLabToken(host: oldValue)
                KeychainStore.saveGitLabToken(gitLabToken, host: gitLabBaseURL)
            }
        }
    }
    /// Last-used project ID (numeric string) so the board reopens on the same project.
    @Published var gitLabLastProjectId: String {
        didSet { defaults.set(gitLabLastProjectId, forKey: "gitLabLastProjectId") }
    }
    /// Saved projects list — replaces the old single-project pin.
    @Published var gitLabSavedProjects: [SavedGitLabProject] {
        didSet {
            if let data = try? AppJSON.encoder.encode(gitLabSavedProjects) {
                defaults.set(data, forKey: "gitLabSavedProjects")
            }
        }
    }

    var gitLabActiveProjectId: Int? {
        gitLabSavedProjects.first(where: { $0.isActive })?.resolvedId
    }

    // ── GitHub integration ────────────────────────────────────────────
    /// PAT (classic or fine-grained). Stored in Keychain.
    @Published var gitHubToken: String {
        didSet {
            if gitHubToken.isEmpty {
                KeychainStore.deleteGitHubToken()
            } else {
                KeychainStore.saveGitHubToken(gitHubToken)
            }
        }
    }
    /// Saved repositories — same shape as gitLabSavedProjects but for GitHub.
    @Published var gitHubSavedRepos: [SavedGitHubRepo] {
        didSet {
            if let data = try? AppJSON.encoder.encode(gitHubSavedRepos) {
                defaults.set(data, forKey: "gitHubSavedRepos")
            }
        }
    }
    var gitHubActiveRepoId: Int? {
        gitHubSavedRepos.first(where: { $0.isActive })?.resolvedId
    }

    // ── Regression check (Phase D) ────────────────────────────────────
    /// Short app version (CFBundleShortVersionString) at the time of
    /// the last app launch. Arms the manual regression-run button
    /// whenever it doesn't match the current bundle version.
    @Published var lastSeenAppVersion: String {
        didSet { defaults.set(lastSeenAppVersion, forKey: "lastSeenAppVersion") }
    }
    /// Wall-clock time of the most recent regression-check run.
    /// Surfaces in the menu-bar pill as a relative timestamp.
    @Published var lastRegressionRunAt: Date? {
        didSet {
            if let d = lastRegressionRunAt {
                defaults.set(d.timeIntervalSince1970, forKey: "lastRegressionRunAt")
            } else {
                defaults.removeObject(forKey: "lastRegressionRunAt")
            }
        }
    }
    /// Number of faults the last regression run flipped from fixed
    /// to open. 0 when nothing drifted. The pill suppresses the
    /// row when this is 0 and we've never run.
    @Published var lastRegressionRegressedCount: Int {
        didSet { defaults.set(lastRegressionRegressedCount, forKey: "lastRegressionRegressedCount") }
    }

    // ── Paths (Phase G + H) ───────────────────────────────────────────
    /// Absolute workspace root. Every named subfolder below resolves
    /// to `dataRoot / <subfolder>`. Empty string = "not yet
    /// configured" — subsystems gracefully fall back to their legacy
    /// per-feature settings (notes folder bookmark, GitLab clone
    /// paths, etc.) until the user picks a root.
    @Published var dataRoot: String {
        didSet { defaults.set(dataRoot, forKey: "dataRoot") }
    }
    @Published var notesSubdir: String {
        didSet { defaults.set(notesSubdir, forKey: "notesSubdir") }
    }
    @Published var docsSubdir: String {
        didSet { defaults.set(docsSubdir, forKey: "docsSubdir") }
    }
    @Published var clonesSubdir: String {
        didSet { defaults.set(clonesSubdir, forKey: "clonesSubdir") }
    }
    @Published var infiniteBrainSubdir: String {
        didSet { defaults.set(infiniteBrainSubdir, forKey: "infiniteBrainSubdir") }
    }
    /// Per-repo subdir inside the active repo where memory artifacts
    /// live (faults/, q&a/, repo.md, graph-notes.md). Unlike the
    /// global subfolders above, this is relative to whichever repo
    /// is selected — it doesn't live under dataRoot.
    @Published var memorySubdir: String {
        didSet { defaults.set(memorySubdir, forKey: "memorySubdir") }
    }
    /// Optional absolute path to the `understand-anything` CLI binary. Empty
    /// means auto-discover from PATH + the usual install locations.
    @Published var uaBinaryOverride: String {
        didSet { defaults.set(uaBinaryOverride, forKey: "uaBinaryOverride") }
    }
    /// Absolute paths to local source-code folders added directly by the user
    /// (outside of the GitHub/GitLab clone flow). Each path is indexed into
    /// the Library as a .code item so the Code Graph can scan it.
    @Published var localCodeFolders: [String] {
        didSet {
            if let data = try? AppJSON.encoder.encode(localCodeFolders) {
                defaults.set(data, forKey: "localCodeFolders")
            }
        }
    }

    // Defaults — single source of truth.
    static let defaultMemorySubdir = ".understand-anything/memory"
    static let defaultNotesSubdir = "Notes"
    static let defaultDocsSubdir = "Docs"
    static let defaultClonesSubdir = "Clones"
    static let defaultInfiniteBrainSubdir = "InfiniteBrain"

    // ── Auto Code Update ──────────────────────────────────────────────
    /// When true, the app automatically scans recent meeting notes for
    /// action items and creates GitLab issues, then invokes the active
    /// AI CLI tool to implement each issue.
    @Published var autoCodeUpdateEnabled: Bool {
        didSet { defaults.set(autoCodeUpdateEnabled, forKey: "autoCodeUpdateEnabled") }
    }

    /// Number of recent meeting notes to scan when auto code update runs.
    @Published var autoCodeUpdateLookbackCount: Int {
        didSet { defaults.set(autoCodeUpdateLookbackCount, forKey: "autoCodeUpdateLookbackCount") }
    }

    /// Which review task types to include in the auto-run pipeline.
    @Published var autoCodeRunReviewCode: Bool {
        didSet { defaults.set(autoCodeRunReviewCode, forKey: "autoCodeRunReviewCode") }
    }
    @Published var autoCodeRunReviewDoc: Bool {
        didSet { defaults.set(autoCodeRunReviewDoc, forKey: "autoCodeRunReviewDoc") }
    }
    @Published var autoCodeRunReviewConflicts: Bool {
        didSet { defaults.set(autoCodeRunReviewConflicts, forKey: "autoCodeRunReviewConflicts") }
    }
    /// Whether the Auto Code Update run also fires a regression sweep
    /// against `<repo>/.understand-anything/memory/faults/` (re-asks every
    /// `status: fixed` fault, auto-reopens regressions). Off by default
    /// — the sweep can be slow on a big fault archive and uses LLM
    /// turns, so users opt in.
    @Published var autoCodeRunRegression: Bool {
        didSet { defaults.set(autoCodeRunRegression, forKey: "autoCodeRunRegression") }
    }

    // Default prompt templates for each auto task type.
    static let defaultTemplateReviewCode = "Review the recent commits in this repository. Check for bugs, security issues, and code style problems. Write a summary to REVIEW.md."
    static let defaultTemplateReviewDoc = "Review the documentation in this repository. Update any docs that are out of date with recent code changes. Fix unclear or incomplete sections."
    static let defaultTemplateReviewConflicts = "Check for and resolve any merge conflicts in this repository. Create a branch named fix/conflicts, resolve all conflicts, commit, and push."

    @Published var autoTaskTemplateReviewCode: String {
        didSet { defaults.set(autoTaskTemplateReviewCode, forKey: "autoTaskTemplateReviewCode") }
    }
    @Published var autoTaskTemplateReviewDoc: String {
        didSet { defaults.set(autoTaskTemplateReviewDoc, forKey: "autoTaskTemplateReviewDoc") }
    }
    @Published var autoTaskTemplateReviewConflicts: String {
        didSet { defaults.set(autoTaskTemplateReviewConflicts, forKey: "autoTaskTemplateReviewConflicts") }
    }

    // ── Backend supervisor ────────────────────────────────────────────
    /// Absolute path to the node binary used to launch `server.mjs`.
    /// Empty until the user picks one (or the auto-detect button finds it).
    @Published var backendNodePath: String {
        didSet { defaults.set(backendNodePath, forKey: "backendNodePath") }
    }
    /// Directory containing `server.mjs` (typically `<repo>/extension`).
    @Published var backendWorkingDir: String {
        didSet { defaults.set(backendWorkingDir, forKey: "backendWorkingDir") }
    }
    /// When true, start the backend automatically on app launch.
    @Published var backendAutoStart: Bool {
        didSet { defaults.set(backendAutoStart, forKey: "backendAutoStart") }
    }

    // ── Sidebar visibility ────────────────────────────────────────────
    /// Raw values of `ShellState.Section` the user has hidden from the
    /// sidebar. Persisted across launches. Only sections listed in
    /// `Section.userHideable` may appear here — Library and Settings
    /// are never hidden (otherwise the user has no way back).
    @Published var hiddenSidebarSections: Set<String> {
        didSet {
            defaults.set(Array(hiddenSidebarSections), forKey: "hiddenSidebarSections")
        }
    }

    /// Internal so tests can construct an AppConfig over an isolated
    /// `UserDefaults(suiteName:)` and not pollute the production
    /// defaults. Production code uses the `shared` singleton.
    init(userDefaults defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.serverURL = (defaults.string(forKey: "serverURL")
            ?? "http://127.0.0.1:\(BackendManager.defaultBackendPort)")
        self.themeID = defaults.string(forKey: "themeID") ?? Theme.dark.id
        self.autoCaptureOnMeeting = defaults.object(forKey: "autoCaptureOnMeeting") as? Bool ?? false
        self.pollIntervalMs = defaults.object(forKey: "pollIntervalMs") as? Int ?? 250
        self.activeCLI = defaults.string(forKey: "activeCLI") ?? AICliTool.claudeCode.rawValue
        self.defaultModelId = defaults.string(forKey: "defaultModelId") ?? AICliTool.claudeCode.defaultModelId
        self.lastSeenAppVersion = defaults.string(forKey: "lastSeenAppVersion") ?? ""
        if defaults.object(forKey: "lastRegressionRunAt") != nil {
            let ts = defaults.double(forKey: "lastRegressionRunAt")
            self.lastRegressionRunAt = ts > 0 ? Date(timeIntervalSince1970: ts) : nil
        } else {
            self.lastRegressionRunAt = nil
        }
        self.lastRegressionRegressedCount = defaults.integer(forKey: "lastRegressionRegressedCount")
        self.dataRoot = defaults.string(forKey: "dataRoot") ?? ""
        let storedNotes = defaults.string(forKey: "notesSubdir") ?? ""
        self.notesSubdir = storedNotes.isEmpty ? AppConfig.defaultNotesSubdir : storedNotes
        let storedDocs = defaults.string(forKey: "docsSubdir") ?? ""
        self.docsSubdir = storedDocs.isEmpty ? AppConfig.defaultDocsSubdir : storedDocs
        let storedClones = defaults.string(forKey: "clonesSubdir") ?? ""
        self.clonesSubdir = storedClones.isEmpty ? AppConfig.defaultClonesSubdir : storedClones
        let storedIB = defaults.string(forKey: "infiniteBrainSubdir") ?? ""
        self.infiniteBrainSubdir = storedIB.isEmpty ? AppConfig.defaultInfiniteBrainSubdir : storedIB
        let storedMem = defaults.string(forKey: "memorySubdir") ?? ""
        self.memorySubdir = storedMem.isEmpty ? AppConfig.defaultMemorySubdir : storedMem
        self.uaBinaryOverride = defaults.string(forKey: "uaBinaryOverride") ?? ""
        if let data = defaults.data(forKey: "localCodeFolders"),
           let decoded = try? AppJSON.decoder.decode([String].self, from: data) {
            self.localCodeFolders = decoded
        } else {
            self.localCodeFolders = []
        }
        let baseURLForInit = defaults.string(forKey: "gitLabBaseURL") ?? "https://gitlab.com"
        self.gitLabBaseURL = baseURLForInit
        if let migrated = defaults.string(forKey: "gitLabToken"), !migrated.isEmpty {
            KeychainStore.saveGitLabToken(migrated, host: baseURLForInit)
            defaults.removeObject(forKey: "gitLabToken")
            self.gitLabToken = migrated
        } else {
            self.gitLabToken = KeychainStore.loadGitLabToken(host: baseURLForInit) ?? ""
        }
        self.gitLabLastProjectId = defaults.string(forKey: "gitLabLastProjectId") ?? ""
        if let data = defaults.data(forKey: "gitLabSavedProjects") {
            do {
                self.gitLabSavedProjects = try AppJSON.decoder.decode([SavedGitLabProject].self, from: data)
            } catch {
                // Stash the corrupt blob aside on disk so we don't lose
                // the user's saved-project list to a silent reset on the
                // next mutation that triggers `defaults.set(...)`.
                let ts = Int(Date().timeIntervalSince1970)
                let fm = FileManager.default
                if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
                    let dir = support.appendingPathComponent("LLM IDE")
                    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
                    let backup = dir.appendingPathComponent("gitLabSavedProjects.json.corrupt-\(ts)")
                    try? data.write(to: backup, options: .atomic)
                    configLogger.warning("Corrupt gitLabSavedProjects stashed to \(backup.path): \(error.localizedDescription)")
                }
                defaults.removeObject(forKey: "gitLabSavedProjects")
                self.gitLabSavedProjects = []
            }
        } else if let oldId = defaults.string(forKey: "gitLabProjectId"), !oldId.isEmpty {
            // Migrate from old single-project setting
            self.gitLabSavedProjects = [SavedGitLabProject(url: "", resolvedId: Int(oldId), isActive: true)]
        } else {
            self.gitLabSavedProjects = []
        }
        // GitHub: token from Keychain, saved repos from UserDefaults.
        self.gitHubToken = KeychainStore.loadGitHubToken() ?? ""
        if let data = defaults.data(forKey: "gitHubSavedRepos"),
           let decoded = try? AppJSON.decoder.decode([SavedGitHubRepo].self, from: data) {
            self.gitHubSavedRepos = decoded
        } else {
            self.gitHubSavedRepos = []
        }
        self.autoCodeUpdateEnabled = defaults.object(forKey: "autoCodeUpdateEnabled") as? Bool ?? false
        self.autoCodeUpdateLookbackCount = defaults.object(forKey: "autoCodeUpdateLookbackCount") as? Int ?? 5
        self.autoCodeRunReviewCode = defaults.object(forKey: "autoCodeRunReviewCode") as? Bool ?? true
        self.autoCodeRunReviewDoc = defaults.object(forKey: "autoCodeRunReviewDoc") as? Bool ?? true
        self.autoCodeRunReviewConflicts = defaults.object(forKey: "autoCodeRunReviewConflicts") as? Bool ?? false
        self.autoCodeRunRegression = defaults.object(forKey: "autoCodeRunRegression") as? Bool ?? false
        self.autoTaskTemplateReviewCode = defaults.string(forKey: "autoTaskTemplateReviewCode") ?? Self.defaultTemplateReviewCode
        self.autoTaskTemplateReviewDoc = defaults.string(forKey: "autoTaskTemplateReviewDoc") ?? Self.defaultTemplateReviewDoc
        self.autoTaskTemplateReviewConflicts = defaults.string(forKey: "autoTaskTemplateReviewConflicts") ?? Self.defaultTemplateReviewConflicts
        self.backendNodePath = defaults.string(forKey: "backendNodePath") ?? ""
        self.backendWorkingDir = defaults.string(forKey: "backendWorkingDir") ?? ""
        self.backendAutoStart = defaults.object(forKey: "backendAutoStart") as? Bool ?? false
        if let raw = defaults.array(forKey: "hiddenSidebarSections") as? [String] {
            // Drop rawValues that no longer match a real Section case —
            // keeps the persisted set from accumulating dead entries
            // across enum-rename refactors. Only Section.userHideable
            // values are accepted (Library / Live / Settings must never
            // end up here even via manual UserDefaults editing).
            let allowed = Set(ShellState.Section.userHideable.map(\.rawValue))
            self.hiddenSidebarSections = Set(raw).intersection(allowed)
        } else {
            self.hiddenSidebarSections = []
        }
    }

    /// Validates the server URL before persisting it.  Only localhost /
    /// 127.0.0.1 addresses are accepted to prevent the app from being
    /// configured to forward transcripts and tokens to an arbitrary host.
    static func isSafeServerURL(_ raw: String) -> Bool {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              let host = url.host, !host.isEmpty else { return false }
        let lower = host.lowercased()
        return lower == "localhost" || lower == "127.0.0.1" || lower == "::1"
    }
}

// MARK: - Active repo helpers (memory/feedback features)

extension AppConfig {
    /// First active+cloned repo, GitLab tried before GitHub. Returns
    /// nil when no repo is linked — callers gate write features
    /// (bug reports, regression checks, etc) on this being non-nil.
    /// Shared by CodeAssistantPanel + RegressionView so the two
    /// can't drift on what "active repo" means.
    var activeRepoLocalURL: URL? {
        if let p = gitLabSavedProjects.first(where: { $0.isActive && $0.isCloned }),
           let url = p.localURL {
            return url
        }
        if let r = gitHubSavedRepos.first(where: { $0.isActive && $0.isCloned }),
           let url = r.localURL {
            return url
        }
        return nil
    }

    /// Build a MemoryStore configured with the current memorySubdir
    /// setting. Single chokepoint so callers don't have to remember
    /// to thread the setting through manually.
    var memoryStore: MemoryStore {
        MemoryStore(memorySubdir: memorySubdir.isEmpty
                    ? AppConfig.defaultMemorySubdir
                    : memorySubdir)
    }

    // MARK: - Resolved workspace paths

    /// Absolute URL of `dataRoot`, with `~` expanded. Returns nil
    /// when the root hasn't been set yet — callers fall back to
    /// their legacy per-feature setting (notes folder bookmark,
    /// GitLab clone path, etc.) in that case.
    var dataRootURL: URL? {
        let trimmed = dataRoot.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let expanded = (trimmed as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded)
    }

    var resolvedNotesURL: URL? { dataRootURL?.appendingPathComponent(notesSubdir, isDirectory: true) }
    var resolvedDocsURL: URL? { dataRootURL?.appendingPathComponent(docsSubdir, isDirectory: true) }
    var resolvedClonesURL: URL? { dataRootURL?.appendingPathComponent(clonesSubdir, isDirectory: true) }
    var resolvedInfiniteBrainURL: URL? { dataRootURL?.appendingPathComponent(infiniteBrainSubdir, isDirectory: true) }

    /// Default clones location when no Paths root is configured. Unlike notes/
    /// docs (which are workspace data and stay unset until a root is chosen),
    /// clones just need somewhere on disk — so they get a sensible default.
    static let defaultClonesFallback: URL = FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent("Documents/LLM IDE/Clones", isDirectory: true)

    /// Where a repo clone should land: the configured `<root>/Clones` if a
    /// Paths root is set, otherwise the default fallback. Always non-nil so
    /// cloning works out of the box — and even while a project is active, when
    /// the global Paths root can't be edited.
    var effectiveClonesURL: URL { resolvedClonesURL ?? AppConfig.defaultClonesFallback }

    /// Every resolved subfolder the user has configured. Used by
    /// "Create missing folders" in PathsSettingsSection.
    var allResolvedSubfolders: [URL] {
        [resolvedNotesURL, resolvedDocsURL, resolvedClonesURL, resolvedInfiniteBrainURL].compactMap { $0 }
    }
}

extension AppConfig {
    /// Snapshot of current AppConfig values projected into a
    /// ProjectSettings shape. Used by ProjectStore.openFolder when
    /// it materialises `<folder>/.llmide/project.json` for the
    /// first time. After Phase 1, AppConfig retains these fields
    /// for back-compat but project-scoped call sites consult the
    /// active Project's bundle instead.
    ///
    /// Note: AppConfig has no global `prefsLanguage` field — the
    /// SettingsView seeds language locally from the backend's
    /// /api/prefs endpoint. We default `language` to "" here, which
    /// matches that view's initial state and means "use the meeting's
    /// own language" downstream.
    var defaultProjectSettings: ProjectSettings {
        ProjectSettings(
            language: "",                   // no global field — see note above
            activeCLI: activeCLI,
            linkedRepo: nil,                // user picks via Settings on first run
            notesFolderRelative: nil,
            enabledPlugins: [],
            uaBinaryOverride: uaBinaryOverride,
            regressionLookbackCount: autoCodeUpdateLookbackCount,
            agentPersona: nil,
            docTemplatesActive: [])
    }
}
