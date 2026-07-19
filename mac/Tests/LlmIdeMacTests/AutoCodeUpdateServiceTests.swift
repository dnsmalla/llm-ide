import Testing
import Foundation
@testable import LlmIdeMac

// These tests cover the pure, side-effect-free helpers on AutoCodeUpdateService.
// Configs are isolated instances (non-standard UserDefaults), which also
// disables AppConfig's keychain persistence — a previous version of this
// suite mutated AppConfig.shared and overwrote the user's REAL GitHub
// token in the login keychain with the test fixture.
@Suite("AutoCodeUpdateService helpers", .serialized)
struct AutoCodeUpdateServiceTests {

    /// Fresh, isolated AppConfig per test. The throwaway suite name keeps
    /// UserDefaults writes out of the app's real domain, and (by the
    /// `persistsSecrets` rule) keeps token writes out of the keychain.
    @MainActor
    private static func isolatedConfig() -> AppConfig {
        AppConfig(userDefaults: UserDefaults(suiteName: "autocode-test-\(UUID().uuidString)")!)
    }

    @Test func normalizeLowercasesText() {
        #expect(NoteActionExtractor.normalize("Fix Bug") == "fix bug")
    }

    @Test func normalizeStripsPunctuation() {
        #expect(NoteActionExtractor.normalize("Fix bug: now!") == "fix bug now")
    }

    @Test func normalizeCollapsesWhitespace() {
        #expect(NoteActionExtractor.normalize("  fix   bug  ") == "fix bug")
    }

    @Test func normalizeHandlesEmpty() {
        #expect(NoteActionExtractor.normalize("") == "")
    }

    @Test func activeProjectGitHubWithTokenResolves() async throws {
        let cfg = await MainActor.run { Self.isolatedConfig() }
        await MainActor.run { cfg.gitHubToken = "ghp_test_token_for_test" }
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let proj = stateRoot.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)

        let store = await MainActor.run {
            ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        }
        let settings = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: ProjectSettings.LinkedRepo(
                kind: .github, url: "https://github.com/o/n",
                remoteId: "o/n", defaultBranch: "main"),
            notesFolderRelative: nil, enabledPlugins: [],
            regressionLookbackCount: 5,
            agentPersona: nil, docTemplatesActive: [])
        let bundle = Project(id: "T", displayName: "T", createdAt: Date(), settings: settings)
        let active = ProjectStore.ActiveProject(bundle: bundle, localPath: proj.path)
        await MainActor.run { store.setActiveForTesting(active) }

        let registry = ProcessedActionsRegistry(
            storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = await MainActor.run {
            AutoCodeUpdateService(config: cfg, autoTaskSettings: AutoTaskSettings(), registry: registry, projectStore: store, logStore: TaskLogStore())
        }
        let resolved = await MainActor.run { svc.resolveBackendAndProject() }
        #expect(resolved?.projectId == "o/n")
        // Linked model: the project root IS the working tree, so both roots
        // resolve to the project path.
        #expect(resolved?.gitRoot == proj.path)
        #expect(resolved?.projectRoot == proj.path)
    }

    /// The fix: in the clone-into-code model (no linkedRepo, repo cloned into
    /// the project's code/), gitRoot must be the CLONE (git ops) while
    /// projectRoot is the PROJECT folder (faults/index). Previously both
    /// resolved to the clone, so AutoCode wrote faults to code/<repo>/system.
    @Test func cloneIntoCodeResolvesGitRootAndProjectRootSeparately() async throws {
        let cfg = await MainActor.run { Self.isolatedConfig() }
        await MainActor.run { cfg.gitHubToken = "ghp_test_token_for_test" }

        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let proj = stateRoot.appendingPathComponent("proj")
        let clone = proj.appendingPathComponent("code/web")
        try FileManager.default.createDirectory(at: clone, withIntermediateDirectories: true)

        // Active project with NO linkedRepo → resolution falls to the config
        // branch (the production path today).
        let store = await MainActor.run {
            ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        }
        let settings = ProjectSettings(
            language: "en", activeCLI: "claudeCode", linkedRepo: nil,
            notesFolderRelative: nil, enabledPlugins: [],
            regressionLookbackCount: 5, agentPersona: nil, docTemplatesActive: [])
        let bundle = Project(id: "T", displayName: "T", createdAt: Date(), settings: settings)
        let active = ProjectStore.ActiveProject(bundle: bundle, localPath: proj.path)
        await MainActor.run { store.setActiveForTesting(active) }

        // Active, cloned GitHub repo whose clone lives under the project's code/.
        await MainActor.run {
            var r = SavedGitHubRepo(url: "acme/web", displayName: "Web",
                                    resolvedId: 7, isActive: true)
            r.localPath = clone.path
            cfg.gitHubSavedRepos = [r]
        }

        let registry = ProcessedActionsRegistry(
            storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = await MainActor.run {
            AutoCodeUpdateService(config: cfg, autoTaskSettings: AutoTaskSettings(), registry: registry, projectStore: store, logStore: TaskLogStore())
        }
        let resolved = await MainActor.run { svc.resolveBackendAndProject() }
        #expect(resolved?.gitRoot == clone.path)        // git ops target the clone
        #expect(resolved?.projectRoot == proj.path)     // faults/index target the project
    }

    @Test func activeProjectGitHubWithoutTokenReturnsNil() async throws {
        // Isolated configs start with no token — nothing to save/restore.
        let cfg = await MainActor.run { Self.isolatedConfig() }

        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let proj = stateRoot.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)

        let store = await MainActor.run {
            ProjectStore(stateDirectory: stateRoot, defaults: .testDefaults)
        }
        let settings = ProjectSettings(
            language: "en", activeCLI: "claudeCode",
            linkedRepo: ProjectSettings.LinkedRepo(
                kind: .github, url: "https://github.com/o/n",
                remoteId: "o/n", defaultBranch: nil),
            notesFolderRelative: nil, enabledPlugins: [],
            regressionLookbackCount: 5,
            agentPersona: nil, docTemplatesActive: [])
        let bundle = Project(id: "T", displayName: "T", createdAt: Date(), settings: settings)
        let active = ProjectStore.ActiveProject(bundle: bundle, localPath: proj.path)
        await MainActor.run { store.setActiveForTesting(active) }

        let registry = ProcessedActionsRegistry(
            storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = await MainActor.run {
            AutoCodeUpdateService(config: cfg, autoTaskSettings: AutoTaskSettings(), registry: registry, projectStore: store, logStore: TaskLogStore())
        }
        let resolved = await MainActor.run { svc.resolveBackendAndProject() }
        #expect(resolved == nil)
    }

    @MainActor
    @Test func runSingleIsNoOpWhileRunInFlight() async {
        let cfg = Self.isolatedConfig()
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-single-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let registry = ProcessedActionsRegistry(storeURL: stateRoot.appendingPathComponent("reg.json"))
        let svc = AutoCodeUpdateService(config: cfg, autoTaskSettings: AutoTaskSettings(),
                                        registry: registry, logStore: TaskLogStore())

        // No backend configured → run() returns early. The re-entrancy guard
        // means runSingle is a no-op while runNow's Task exists. Assert the
        // service stays consistent and does not crash.
        svc.runNow()
        svc.runSingle(.reviewCode)
        #expect(svc.currentTask == nil)
    }

    /// Toggling `enabled` via the model (the Menu/Settings path — no explicit
    /// start()/stop() call) must arm AND disarm the scheduler. Previously the
    /// observer only called stop() on disable, so enabling from the Menu bar
    /// flipped the displayed state but left the timer unarmed: auto-tasks
    /// never ran on schedule.
    @MainActor
    @Test func enablingViaModelArmsAndDisarmsTheAutoTimer() async {
        let cfg = Self.isolatedConfig()
        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-timer-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let registry = ProcessedActionsRegistry(storeURL: stateRoot.appendingPathComponent("reg.json"))
        let settings = AutoTaskSettings(
            defaults: UserDefaults(suiteName: "autocode-timer-\(UUID().uuidString)")!)
        settings.enabled = false
        let svc = AutoCodeUpdateService(config: cfg, autoTaskSettings: settings,
                                        registry: registry, logStore: TaskLogStore())

        // Disabled at construction → timer not armed.
        #expect(svc.isAutoTimerArmed == false)

        // Flip enabled via the model — the observer must arm the timer.
        settings.enabled = true
        #expect(svc.isAutoTimerArmed == true)

        // Flipping back off must disarm it.
        settings.enabled = false
        #expect(svc.isAutoTimerArmed == false)
    }

    /// Regression: a GitLab repo that was cloned (localPath set) + marked
    /// active but never "Resolve"d (resolvedId == nil) must STILL resolve —
    /// the local CLI tasks only need the clone path. Previously the GitLab
    /// legacy branch gated on `resolvedId` and returned nil, so Auto Tasks
    /// showed "No linked repo" even though clone/fetch/code-assistant git
    /// worked (they use the looser `isActive && isCloned` predicate).
    @MainActor
    @Test func gitLabClonedButUnresolvedResolves() {
        let cfg = Self.isolatedConfig()
        cfg.gitLabToken = "glpat-test-token"
        var p = SavedGitLabProject(url: "https://gitlab.com/acme/app",
                                   displayName: "App", isActive: true)
        p.localPath = "/tmp/llm-ide-test-clone-\(UUID().uuidString)"
        cfg.gitLabSavedProjects = [p]

        let stateRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("auto-gl-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: stateRoot, withIntermediateDirectories: true)
        let registry = ProcessedActionsRegistry(storeURL: stateRoot.appendingPathComponent("reg.json"))
        // No projectStore → no active project / no linkedRepo → forces the
        // legacy GitLab branch (the one that used to gate on resolvedId).
        let svc = AutoCodeUpdateService(config: cfg, autoTaskSettings: AutoTaskSettings(),
                                        registry: registry, logStore: TaskLogStore())

        let resolved = svc.resolveBackendAndProject()
        #expect(resolved != nil)
        #expect(resolved?.gitRoot == p.localPath)
    }
}
