import XCTest
@testable import LlmIdeMacLib

/// Guards how the active project's `linkedRepo` is derived from Settings.
///
/// The derivation used to be gated on the PATs being non-empty, so a token
/// that merely couldn't be read (denied / locked keychain) looked identical to
/// "no repo configured" — and `syncLinkedRepoFromConfig`, which runs on every
/// launch, then wrote `linkedRepo: nil` into `system/project.json`. A repo the
/// user had configured, cloned and marked active silently lost its link and
/// Auto Tasks reported "No linked repo".
///
/// Auth availability decides whether we can CALL a backend. It must not decide
/// which repo a project targets.
@MainActor
final class LinkedRepoDerivationTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var config: AppConfig!

    override func setUp() {
        super.setUp()
        suiteName = "LinkedRepoDerivationTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        // A non-standard suite also sets persistsSecrets = false, so this
        // config never touches the real keychain.
        config = AppConfig(userDefaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func activeGitHubRepo(url: String = "https://github.com/acme/widgets") -> SavedGitHubRepo {
        var r = SavedGitHubRepo()
        r.url = url
        r.isActive = true
        r.defaultBranch = "main"
        return r
    }

    private func activeGitLabProject(url: String = "https://gitlab.com/acme/widgets") -> SavedGitLabProject {
        var p = SavedGitLabProject(url: url, displayName: "widgets", resolvedId: 42, isActive: true)
        p.defaultBranch = "main"
        return p
    }

    // MARK: - The regression

    /// The core fix: an active saved repo resolves even when its token is
    /// unavailable, so an unreadable keychain can't erase the link.
    func testActiveRepoResolvesWithoutAToken() {
        config.gitHubSavedRepos = [activeGitHubRepo()]
        XCTAssertTrue(config.gitHubToken.isEmpty, "precondition: no token available")

        guard case .github(let r)? = config.linkTargetRepo else {
            return XCTFail("expected the active GitHub repo to resolve without a token")
        }
        XCTAssertEqual(r.url, "https://github.com/acme/widgets")
    }

    /// …while the token-gated resolver keeps its existing meaning, because
    /// "which backend can we call" genuinely does depend on credentials.
    func testActiveConfigRepoStaysTokenGated() {
        config.gitHubSavedRepos = [activeGitHubRepo()]
        XCTAssertNil(config.activeConfigRepo,
                     "callable-backend resolution must still require a token")
    }

    // MARK: - Precedence

    func testPreferenceWinsOverTheDefaultOrdering() {
        config.gitLabSavedProjects = [activeGitLabProject()]
        config.gitHubSavedRepos = [activeGitHubRepo()]

        config.preferredRepoProvider = .github
        guard case .github? = config.linkTargetRepo else {
            return XCTFail("the preferred provider must win")
        }
    }

    /// With no preference the order matches `activeConfigRepo`: GitLab first.
    func testGitLabWinsWhenNoPreferenceIsSet() {
        config.gitLabSavedProjects = [activeGitLabProject()]
        config.gitHubSavedRepos = [activeGitHubRepo()]
        config.preferredRepoProvider = nil

        guard case .gitlab? = config.linkTargetRepo else {
            return XCTFail("GitLab should win when no preference is set")
        }
    }

    /// Preferring a provider you have no repos for must not tear down the
    /// provider you do have — that stranded the user with nothing active,
    /// which every consumer reports as "No repository connected".
    func testPreferringAnUnconfiguredProviderKeepsTheConfiguredOneActive() {
        config.gitHubSavedRepos = [activeGitHubRepo()]
        config.gitLabSavedProjects = []

        config.preferredRepoProvider = .gitlab

        XCTAssertTrue(config.gitHubSavedRepos[0].isActive,
                      "the only configured repo must stay active")
        guard case .github? = config.linkTargetRepo else {
            return XCTFail("expected fall-through to the only configured provider")
        }
    }

    /// Preferring a provider whose repos exist but are all inactive (the state
    /// the previous preference left behind) must activate one, not leave every
    /// provider switched off.
    func testPreferringAProviderWithOnlyInactiveReposActivatesOne() {
        var inactive = activeGitHubRepo()
        inactive.isActive = false
        config.gitHubSavedRepos = [inactive]
        config.gitLabSavedProjects = [activeGitLabProject()]

        config.preferredRepoProvider = .github

        XCTAssertTrue(config.gitHubSavedRepos[0].isActive)
        XCTAssertFalse(config.gitLabSavedProjects[0].isActive)
        guard case .github? = config.linkTargetRepo else {
            return XCTFail("expected the preferred provider to resolve")
        }
    }

    func testNoActiveRepoResolvesToNil() {
        var inactive = activeGitHubRepo()
        inactive.isActive = false
        config.gitHubSavedRepos = [inactive]

        XCTAssertNil(config.linkTargetRepo)
    }
}
