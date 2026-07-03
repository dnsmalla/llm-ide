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
        #expect(cfg.isAllowed(.merge, provider: .github))
        #expect(cfg.isAllowed(.createIssue, provider: .github) == false)
    }
}
