import Foundation
import Combine
import os.log

private let configLogger = Logger(subsystem: "com.llmide.macapp", category: "AppConfig")

/// Decode persisted config data, or — on corruption — stash the bad blob
/// aside (under Application Support/LLM IDE) so the user's settings aren't
/// silently lost on the next `defaults.set(...)`, log a warning, clear the
/// key, and return nil. Mirrors the recovery already used for
/// `gitLabSavedProjects`.
private func decodeConfigOrStash<T: Decodable>(
    _ type: T.Type, key: String, data: Data, defaults: UserDefaults) -> T? {
    do {
        return try AppJSON.decoder.decode(type, from: data)
    } catch {
        let ts = Int(Date().timeIntervalSince1970)
        let fm = FileManager.default
        if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let dir = support.appendingPathComponent("LLM IDE")
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let backup = dir.appendingPathComponent("\(key).json.corrupt-\(ts)")
            try? data.write(to: backup, options: .atomic)
            configLogger.warning("Corrupt \(key) stashed to \(backup.path): \(error.localizedDescription)")
        }
        defaults.removeObject(forKey: key)
        return nil
    }
}

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

/// A configured Email input source. The IMAP **password is never stored
/// here** — it lives in the server-side secrets vault under
/// `email.imapPassword` (see `LlmIdeAPIClient.setSecret`). Everything in
/// this struct is non-secret connection metadata, safe to persist in
/// UserDefaults alongside the other saved-connection structs.
struct SavedEmailSource: Codable, Equatable {
    var displayName: String = ""
    var host: String = "imap.gmail.com"
    var port: Int = 993
    var secure: Bool = true
    var user: String = ""          // email address / IMAP username
    var mailbox: String = "INBOX"
    var lookbackDays: Int = 7      // clamp: never look back further than this
    var enabled: Bool = true
    /// Only import unread messages — the usual case (read mail is noise).
    var unreadOnly: Bool = true
    /// Optional sender substring filter (IMAP FROM search). Empty = all.
    var fromFilter: String = ""

    init() {}

    /// Tolerant decoder: every field falls back to its default when absent,
    /// so adding fields over time never invalidates a previously-saved
    /// source (synthesized Codable would otherwise throw on a missing key).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName  = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        host         = try c.decodeIfPresent(String.self, forKey: .host) ?? "imap.gmail.com"
        port         = try c.decodeIfPresent(Int.self, forKey: .port) ?? 993
        secure       = try c.decodeIfPresent(Bool.self, forKey: .secure) ?? true
        user         = try c.decodeIfPresent(String.self, forKey: .user) ?? ""
        mailbox      = try c.decodeIfPresent(String.self, forKey: .mailbox) ?? "INBOX"
        lookbackDays = try c.decodeIfPresent(Int.self, forKey: .lookbackDays) ?? 7
        enabled      = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        unreadOnly   = try c.decodeIfPresent(Bool.self, forKey: .unreadOnly) ?? true
        fromFilter   = try c.decodeIfPresent(String.self, forKey: .fromFilter) ?? ""
    }
}

struct SavedSlackSource: Codable, Equatable {
    var displayName: String = ""
    /// Slack channel IDs (e.g. "C0123ABCD") the bot is invited to.
    var channels: [String] = []
    var lookbackDays: Int = 7
    var enabled: Bool = true

    init() {}

    /// Tolerant decoder — every field falls back to its default when absent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName  = try c.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        channels     = try c.decodeIfPresent([String].self, forKey: .channels) ?? []
        lookbackDays = try c.decodeIfPresent(Int.self, forKey: .lookbackDays) ?? 7
        enabled      = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}

/// User-tunable settings persisted to UserDefaults.
final class AppConfig: ObservableObject {
    static let shared = AppConfig()

    private let defaults: UserDefaults
    /// False for isolated instances (tests, previews) constructed with a
    /// non-standard UserDefaults. Gates every KeychainStore read/write so
    /// a test config can NEVER clobber the user's real tokens — a test
    /// fixture once overwrote the user's GitHub PAT with
    /// "ghp_test_token_for_test" through exactly this hole.
    private let persistsSecrets: Bool

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

    /// How often the background GraphAutoUpdater regenerates the code-graph /
    /// memory for the active project, in minutes. Floored at 5 (the updater
    /// clamps below that). Persisted so it survives launches.
    @Published var graphAutoUpdateMinutes: Int {
        didSet { defaults.set(graphAutoUpdateMinutes, forKey: "graphAutoUpdateMinutes") }
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
            guard persistsSecrets else { return }
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
            if persistsSecrets, !gitLabToken.isEmpty {
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
            guard persistsSecrets else { return }
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

    // ── External sources: Email ───────────────────────────────────────
    /// The single configured Email source, or nil when not set up. JSON-
    /// persisted exactly like `gitLabSavedProjects` — the IMAP password is
    /// NOT part of this (it lives in the server vault). nil = "Not
    /// configured" in the Sources view.
    @Published var emailSource: SavedEmailSource? {
        didSet {
            if let s = emailSource, let data = try? AppJSON.encoder.encode(s) {
                defaults.set(data, forKey: "emailSource")
            } else {
                defaults.removeObject(forKey: "emailSource")
            }
        }
    }

    @Published var slackSource: SavedSlackSource? {
        didSet {
            if let s = slackSource, let data = try? AppJSON.encoder.encode(s) {
                defaults.set(data, forKey: "slackSource")
            } else {
                defaults.removeObject(forKey: "slackSource")
            }
        }
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
    /// When true, a regressed verdict reopens the fault on disk
    /// (`fixed` → `open`). Default OFF: the verdict is a heuristic
    /// text comparison, so the run reports drift but never mutates
    /// files unless the user opts in.
    @Published var regressionAutoReopen: Bool {
        didSet { defaults.set(regressionAutoReopen, forKey: "regressionAutoReopen") }
    }
    @Published var regressionAttemptRepair: Bool {
        didSet { defaults.set(regressionAttemptRepair, forKey: "regressionAttemptRepair") }
    }
    @Published var regressionVerifyTimeout: TimeInterval {
        didSet { defaults.set(regressionVerifyTimeout, forKey: "regressionVerifyTimeout") }
    }

    // ── Paths ─────────────────────────────────────────────────────────
    /// Per-repo subdir inside the active repo where memory artifacts
    /// live (faults/, q&a/, repo.md, graph-notes.md). This is relative
    /// to whichever repo is currently selected.
    @Published var memorySubdir: String {
        didSet { defaults.set(memorySubdir, forKey: "memorySubdir") }
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
    // The MemoryStore CONTAINER (it appends faults/ + q&a/ inside this).
    // Must be `system`, not `system/faults`, or faults double-nest to
    // `system/faults/faults`. Mirrors ProjectLayout.memorySubdir.
    static let defaultMemorySubdir = ProjectLayout.memorySubdir

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

    /// How often the auto-task timer fires, in minutes. Drives the
    /// repeating scheduler in AutoCodeUpdateService (was a hardcoded 60).
    @Published var autoCodeIntervalMinutes: Int {
        didSet { defaults.set(autoCodeIntervalMinutes, forKey: "autoCodeIntervalMinutes") }
    }

    /// Lookback mode for the meeting scan. false = by count (the historical
    /// behaviour, uses `autoCodeUpdateLookbackCount`); true = by age in days
    /// (uses `autoCodeLookbackDays`).
    @Published var autoCodeLookbackByDays: Bool {
        didSet { defaults.set(autoCodeLookbackByDays, forKey: "autoCodeLookbackByDays") }
    }
    /// Age window (days) for the by-age lookback mode.
    @Published var autoCodeLookbackDays: Int {
        didSet { defaults.set(autoCodeLookbackDays, forKey: "autoCodeLookbackDays") }
    }

    /// When true, auto-tasks stash uncommitted changes before running and
    /// restore them after, instead of skipping on a dirty tree. Off by
    /// default — stashing the user's WIP is surprising, so it's opt-in.
    @Published var autoCodeAutoStash: Bool {
        didSet { defaults.set(autoCodeAutoStash, forKey: "autoCodeAutoStash") }
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
    /// against `<repo>/system/faults/` (re-asks every
    /// `status: fixed` fault, auto-reopens regressions). Off by default
    /// — the sweep can be slow on a big fault archive and uses LLM
    /// turns, so users opt in.
    @Published var autoCodeRunRegression: Bool {
        didSet { defaults.set(autoCodeRunRegression, forKey: "autoCodeRunRegression") }
    }
    /// Surface the auto-generated knowledge (code graph + memory + index) as a
    /// reviewable Auto Tasks row. Default ON — knowledge generation is core to
    /// the product's autonomous purpose; the row is read-only status, cheap.
    @Published var autoCodeRunGenerateKnowledge: Bool {
        didSet { defaults.set(autoCodeRunGenerateKnowledge, forKey: "autoCodeRunGenerateKnowledge") }
    }

    // Default prompt templates for each auto task type. Review tasks are
    // READ-ONLY: they must not modify the repo (the loop reverts any stray
    // edits) — their findings are captured from stdout in the task log.
    static let defaultTemplateReviewCode = "Review the recent commits in this repository for bugs, security issues, and code style problems. This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. Print your findings as a summary to your output."
    static let defaultTemplateReviewDoc = "Review the documentation in this repository for sections that are out of date with recent code changes, unclear, or incomplete. This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. List the specific docs and the fixes you would make to your output."
    static let defaultTemplateReviewConflicts = "Check this repository for merge conflicts (conflict markers, unmerged paths). This is a READ-ONLY review: do NOT edit, create, or delete any files, and do NOT commit or push. List which files conflict and how you would resolve each to your output."

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
        self.persistsSecrets = (defaults === UserDefaults.standard)
        self.serverURL = (defaults.string(forKey: "serverURL")
            ?? "http://127.0.0.1:\(BackendManager.defaultBackendPort)")
        self.themeID = defaults.string(forKey: "themeID") ?? Theme.light.id
        self.autoCaptureOnMeeting = defaults.object(forKey: "autoCaptureOnMeeting") as? Bool ?? false
        self.pollIntervalMs = defaults.object(forKey: "pollIntervalMs") as? Int ?? 250
        self.graphAutoUpdateMinutes = max(5, defaults.object(forKey: "graphAutoUpdateMinutes") as? Int ?? 15)
        self.activeCLI = defaults.string(forKey: "activeCLI") ?? AICliTool.claudeCode.rawValue
        // Migrate a persisted model id forward. A previously-stored choice
        // can be a retired id (e.g. "claude-opus-4-7") or a tool no longer
        // selectable (Gemini/Cursor) — sending either to the API would
        // 404. Coerce anything not in a current selectable tool's list to
        // a valid model so users who never reopen the picker don't break.
        let selectableModelIds = Set(AICliTool.selectable.flatMap { $0.models.map(\.id) })
        let storedModelId = defaults.string(forKey: "defaultModelId")
        if let storedModelId, selectableModelIds.contains(storedModelId) {
            self.defaultModelId = storedModelId
        } else if storedModelId == "claude-opus-4-7" {
            self.defaultModelId = "claude-opus-4-8"
        } else {
            self.defaultModelId = AICliTool.claudeCode.defaultModelId
        }
        self.lastSeenAppVersion = defaults.string(forKey: "lastSeenAppVersion") ?? ""
        if defaults.object(forKey: "lastRegressionRunAt") != nil {
            let ts = defaults.double(forKey: "lastRegressionRunAt")
            self.lastRegressionRunAt = ts > 0 ? Date(timeIntervalSince1970: ts) : nil
        } else {
            self.lastRegressionRunAt = nil
        }
        self.lastRegressionRegressedCount = defaults.integer(forKey: "lastRegressionRegressedCount")
        self.regressionAutoReopen = defaults.object(forKey: "regressionAutoReopen") as? Bool ?? false
        self.regressionAttemptRepair = defaults.object(forKey: "regressionAttemptRepair") as? Bool ?? false
        let savedTimeout = defaults.double(forKey: "regressionVerifyTimeout")
        self.regressionVerifyTimeout = savedTimeout > 0 ? savedTimeout : 120
        // Heal the pre-fix persisted value: "system/faults" used to be the
        // (buggy) container default and would double-nest faults into
        // system/faults/faults. Treat it as unset so it falls back to the
        // corrected default. memorySubdir has no Settings UI anymore.
        var storedMem = defaults.string(forKey: "memorySubdir") ?? ""
        if storedMem == "system/faults" { storedMem = "" }
        self.memorySubdir = storedMem.isEmpty ? AppConfig.defaultMemorySubdir : storedMem
        if let data = defaults.data(forKey: "localCodeFolders"),
           let decoded = decodeConfigOrStash([String].self, key: "localCodeFolders", data: data, defaults: defaults) {
            self.localCodeFolders = decoded
        } else {
            self.localCodeFolders = []
        }
        let baseURLForInit = defaults.string(forKey: "gitLabBaseURL") ?? "https://gitlab.com"
        self.gitLabBaseURL = baseURLForInit
        if !self.persistsSecrets {
            self.gitLabToken = ""
        } else if let migrated = defaults.string(forKey: "gitLabToken"), !migrated.isEmpty {
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
        self.gitHubToken = self.persistsSecrets ? (KeychainStore.loadGitHubToken() ?? "") : ""
        if let data = defaults.data(forKey: "gitHubSavedRepos"),
           let decoded = decodeConfigOrStash([SavedGitHubRepo].self, key: "gitHubSavedRepos", data: data, defaults: defaults) {
            self.gitHubSavedRepos = decoded
        } else {
            self.gitHubSavedRepos = []
        }
        if let data = defaults.data(forKey: "emailSource"),
           let decoded = decodeConfigOrStash(SavedEmailSource.self, key: "emailSource", data: data, defaults: defaults) {
            self.emailSource = decoded
        } else {
            self.emailSource = nil
        }
        if let data = defaults.data(forKey: "slackSource"),
           let decoded = decodeConfigOrStash(SavedSlackSource.self, key: "slackSource", data: data, defaults: defaults) {
            self.slackSource = decoded
        } else {
            self.slackSource = nil
        }
        self.autoCodeUpdateEnabled = defaults.object(forKey: "autoCodeUpdateEnabled") as? Bool ?? false
        self.autoCodeUpdateLookbackCount = defaults.object(forKey: "autoCodeUpdateLookbackCount") as? Int ?? 5
        self.autoCodeIntervalMinutes = defaults.object(forKey: "autoCodeIntervalMinutes") as? Int ?? 60
        self.autoCodeLookbackByDays = defaults.object(forKey: "autoCodeLookbackByDays") as? Bool ?? false
        self.autoCodeLookbackDays = defaults.object(forKey: "autoCodeLookbackDays") as? Int ?? 7
        self.autoCodeAutoStash = defaults.object(forKey: "autoCodeAutoStash") as? Bool ?? false
        self.autoCodeRunReviewCode = defaults.object(forKey: "autoCodeRunReviewCode") as? Bool ?? true
        self.autoCodeRunReviewDoc = defaults.object(forKey: "autoCodeRunReviewDoc") as? Bool ?? true
        self.autoCodeRunReviewConflicts = defaults.object(forKey: "autoCodeRunReviewConflicts") as? Bool ?? false
        self.autoCodeRunRegression = defaults.object(forKey: "autoCodeRunRegression") as? Bool ?? false
        self.autoCodeRunGenerateKnowledge = defaults.object(forKey: "autoCodeRunGenerateKnowledge") as? Bool ?? true
        self.autoTaskTemplateReviewCode = defaults.string(forKey: "autoTaskTemplateReviewCode") ?? Self.defaultTemplateReviewCode
        self.autoTaskTemplateReviewDoc = defaults.string(forKey: "autoTaskTemplateReviewDoc") ?? Self.defaultTemplateReviewDoc
        self.autoTaskTemplateReviewConflicts = defaults.string(forKey: "autoTaskTemplateReviewConflicts") ?? Self.defaultTemplateReviewConflicts
        self.backendNodePath = defaults.string(forKey: "backendNodePath") ?? ""
        self.backendWorkingDir = defaults.string(forKey: "backendWorkingDir") ?? ""
        // Default ON so the out-of-box experience (backend auto-starts on
        // launch) is preserved now that the toggle actually gates it.
        self.backendAutoStart = defaults.object(forKey: "backendAutoStart") as? Bool ?? true
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

// MARK: - Email source helpers

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

    /// Default clones location. Clones just need somewhere on disk —
    /// so they get a sensible default.
    static let defaultClonesFallback: URL = FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent("Documents/LLM IDE/Clones", isDirectory: true)

    /// Where a no-project repo clone should land. Used by the
    /// GitHub/GitLab clone code as the fallback when no project is
    /// active. Always non-nil so cloning works out of the box.
    var effectiveClonesURL: URL { AppConfig.defaultClonesFallback }
}

extension AppConfig {
    /// Snapshot of current AppConfig values projected into a
    /// ProjectSettings shape. Used by ProjectStore.openFolder when
    /// it materialises `<folder>/system/project.json` for the
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
            regressionLookbackCount: autoCodeUpdateLookbackCount,
            agentPersona: nil,
            docTemplatesActive: [])
    }
}
