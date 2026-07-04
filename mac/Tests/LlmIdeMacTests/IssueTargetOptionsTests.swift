import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("IssueTargetOptions")
struct IssueTargetOptionsTests {

    private func makeConfig() -> AppConfig {
        let name = "issue-target-options-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return AppConfig(userDefaults: d)
    }

    @Test func allReturnsGitHubAndGitLabOptions() {
        let config = makeConfig()

        config.gitHubToken = "gh-token"
        config.gitHubSavedRepos = [
            SavedGitHubRepo(url: "https://github.com/o/n", displayName: "", resolvedId: nil, isActive: true)
        ]

        config.gitLabToken = "gl-token"
        config.gitLabSavedProjects = [
            SavedGitLabProject(url: "https://gitlab.com/g/p", displayName: "", resolvedId: 7, isActive: false)
        ]

        let options = IssueTargetOptions.all(config: config)

        #expect(options.count == 2)

        guard let github = options.first(where: { $0.kind == .github }) else {
            Issue.record("missing GitHub option")
            return
        }
        #expect(github.projectId == "o/n")
        #expect(github.isActive == true)

        guard let gitlab = options.first(where: { $0.kind == .gitlab }) else {
            Issue.record("missing GitLab option")
            return
        }
        #expect(gitlab.projectId == "7")
        #expect(gitlab.isActive == false)
    }
}
