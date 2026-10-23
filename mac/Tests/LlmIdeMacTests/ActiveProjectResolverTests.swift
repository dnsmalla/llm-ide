import XCTest
@testable import LlmIdeMacLib

/// `ActiveProjectResolver` (Core) — the active-project derivation Chat and
/// Issues share. Chat's `CodeAssistantPanel.deriveActiveProject` statics must
/// stay pure forwards, so Issues' recent-issues key and the agent context can
/// never disagree about which project is active.
@MainActor
final class ActiveProjectResolverTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var config: AppConfig!

    override func setUp() {
        super.setUp()
        suiteName = "ActiveProjectResolverTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        // A non-standard suite sets persistsSecrets = false, so the tokens
        // assigned below never touch the real keychain.
        config = AppConfig(userDefaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testNoActiveWorkspaceProjectIsNil() {
        XCTAssertNil(ActiveProjectResolver.project(from: nil))
    }

    func testNoConfiguredRepoIsNil() {
        XCTAssertNil(ActiveProjectResolver.project(fromConfig: config))
    }

    func testGitLabConfigRepoResolves() {
        var project = SavedGitLabProject(url: "https://gitlab.com/acme/widgets",
                                         displayName: "Widgets", resolvedId: 1, isActive: true)
        project.defaultBranch = "develop"
        config.gitLabSavedProjects = [project]
        config.gitLabToken = "token"

        let resolved = ActiveProjectResolver.project(fromConfig: config)
        XCTAssertEqual(resolved?.name, "Widgets")
        XCTAssertEqual(resolved?.url, "https://gitlab.com/acme/widgets")
        XCTAssertEqual(resolved?.defaultBranch, "develop")
        XCTAssertEqual(resolved?.provider, "GitLab")
    }

    /// An empty display name falls back to the url's last path component.
    func testGitHubConfigRepoNameFallsBackToURL() {
        var repo = SavedGitHubRepo()
        repo.url = "https://github.com/acme/gadgets"
        repo.isActive = true
        config.gitHubSavedRepos = [repo]
        config.gitHubToken = "token"

        let resolved = ActiveProjectResolver.project(fromConfig: config)
        XCTAssertEqual(resolved?.name, "gadgets")
        XCTAssertEqual(resolved?.provider, "GitHub")
    }

    /// The config fallback is token-gated (via `activeConfigRepo`). The phone
    /// bridge (`MobileExploreBridge`) used to carry a private copy that checked
    /// the tokens inline; it now calls this resolver, so the gating it relied
    /// on is pinned here: an active repo without a token is not the active
    /// project, and a tokenless GitLab falls through to a tokened GitHub.
    func testConfigFallbackIsTokenGated() {
        config.gitLabSavedProjects = [SavedGitLabProject(url: "https://gitlab.com/acme/widgets",
                                                         displayName: "Widgets", isActive: true)]
        XCTAssertNil(ActiveProjectResolver.project(fromConfig: config))

        var repo = SavedGitHubRepo()
        repo.url = "https://github.com/acme/gadgets"
        repo.isActive = true
        config.gitHubSavedRepos = [repo]
        config.gitHubToken = "token"
        XCTAssertEqual(ActiveProjectResolver.project(fromConfig: config)?.provider, "GitHub")
    }

    func testChatStaticsForwardToTheResolver() {
        config.gitLabSavedProjects = [SavedGitLabProject(url: "https://gitlab.com/acme/widgets",
                                                         displayName: "Widgets", isActive: true)]
        config.gitLabToken = "token"
        XCTAssertEqual(CodeAssistantPanel.deriveActiveProject(fromConfig: config),
                       ActiveProjectResolver.project(fromConfig: config))
        XCTAssertNil(CodeAssistantPanel.deriveActiveProject(from: nil))
    }
}
