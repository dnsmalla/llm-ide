import Testing
import Foundation
@testable import LlmIdeMac

@Suite("Repo operation allow-list")
struct RepoOperationAllowlistTests {

    private func freshDefaults() -> UserDefaults {
        let name = "allowlist-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func defaultsToAllEnabledWhenKeyAbsent() {
        let cfg = AppConfig(userDefaults: freshDefaults())
        for op in RepoOperation.allCases {
            #expect(cfg.isAllowed(op, provider: .github))
            #expect(cfg.isAllowed(op, provider: .gitlab))
        }
    }

    @Test func setAllowedTogglesAndPersistsPerProvider() {
        let defaults = freshDefaults()
        let cfg = AppConfig(userDefaults: defaults)
        cfg.setAllowed(.createIssue, provider: .github, false)
        #expect(cfg.isAllowed(.createIssue, provider: .github) == false)
        // Other provider is untouched.
        #expect(cfg.isAllowed(.createIssue, provider: .gitlab) == true)

        // A new AppConfig on the same defaults reflects the persisted change.
        let reloaded = AppConfig(userDefaults: defaults)
        #expect(reloaded.isAllowed(.createIssue, provider: .github) == false)
        #expect(reloaded.isAllowed(.push, provider: .github) == true)
    }

    @Test func storedEmptyMeansNoneNotDefaultAll() {
        let defaults = freshDefaults()
        let cfg = AppConfig(userDefaults: defaults)
        for op in RepoOperation.allCases { cfg.setAllowed(op, provider: .gitlab, false) }
        let reloaded = AppConfig(userDefaults: defaults)
        for op in RepoOperation.allCases {
            #expect(reloaded.isAllowed(op, provider: .gitlab) == false)
        }
    }

    @Test func decodeIgnoresUnknownOperationStrings() {
        let defaults = freshDefaults()
        defaults.set(["push", "bogus-op", "merge"], forKey: "gitHubAllowedOps")
        let cfg = AppConfig(userDefaults: defaults)
        #expect(cfg.isAllowed(.push, provider: .github))
        // Legacy "merge" rawValue aliases to .closeIssue, not dropped.
        #expect(cfg.isAllowed(.closeIssue, provider: .github))
        #expect(cfg.isAllowed(.createIssue, provider: .github) == false)
    }

    @Test func legacyMergeRawValueDecodesToCloseIssue() {
        let defaults = UserDefaults(suiteName: "allowlist-migrate-\(UUID().uuidString)")!
        // A pre-rename custom set that allowed only "merge" (the old close/reopen op).
        defaults.set(["merge"], forKey: "gitHubAllowedOps")
        let cfg = AppConfig(userDefaults: defaults)
        #expect(cfg.isAllowed(.closeIssue, provider: .github))
    }

    @Test func editIssueIsInDefaultAllEnabledSet() {
        let name = "allowlist-edit-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let cfg = AppConfig(userDefaults: d)
        #expect(cfg.isAllowed(.editIssue, provider: .github))
        #expect(cfg.isAllowed(.closeIssue, provider: .gitlab))
    }

    @MainActor
    @Test func automationStepsRespectAllowList() {
        let defaults = UserDefaults(suiteName: "allowlist-auto-\(UUID().uuidString)")!
        let cfg = AppConfig(userDefaults: defaults)
        cfg.setAllowed(.createIssue, provider: .github, false)
        cfg.setAllowed(.autoCommit, provider: .github, false)

        let steps = AutoCodeUpdateService.allowedAutoSteps(config: cfg, provider: .github)
        #expect(steps.createIssue == false)
        #expect(steps.createBranch == true)   // still enabled
        #expect(steps.autoCommit == false)

        // GitLab side untouched.
        let gl = AutoCodeUpdateService.allowedAutoSteps(config: cfg, provider: .gitlab)
        #expect(gl.createIssue == true)
    }

    // HT4 fix: providerKind normalizes both the query root and the stored
    // localPath, so a path that differs only textually (trailing slash here)
    // still matches — a verbatim compare would fail OPEN (treat a managed repo
    // as unmanaged and skip the SourceControl allow-list gate).
    @Test func providerKindNormalizesPathsBeforeMatching() throws {
        let name = "pk-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let cfg = AppConfig(userDefaults: d)
        // A real directory so resolvingSymlinksInPath is deterministic.
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }
        var r = SavedGitHubRepo(url: "https://github.com/o/r", isActive: true)
        r.localPath = base.path + "/"   // stored WITH a trailing slash (non-standard)
        cfg.gitHubSavedRepos = [r]
        #expect(cfg.providerKind(forRepoRoot: base) == .github, "trailing-slash stored path must still match")
        #expect(cfg.providerKind(forRepoRoot: base.appendingPathComponent("nope")) == nil)
    }
}
