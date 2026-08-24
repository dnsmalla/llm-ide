import Testing
@testable import LlmIdeMac

@Suite("IssueTargetOptions")
struct IssueTargetOptionsTests {
    @Test @MainActor func listsConfiguredRepos() {
        let defaults = UserDefaults(suiteName: "IssueTargetOptionsTests-\(UUID().uuidString)")!
        let config = AppConfig(userDefaults: defaults)
        config.gitHubToken = "gh-token"
        config.gitLabToken = "gl-token"
        config.gitHubSavedRepos = [
            SavedGitHubRepo(url: "https://github.com/o/n", displayName: "o/n", resolvedId: 1, isActive: true)
        ]
        config.gitLabSavedProjects = [
            SavedGitLabProject(url: "https://gitlab.com/acme/app", displayName: "App", resolvedId: 7, isActive: false)
        ]

        let options = IssueTargetOptions.all(config: config)
        #expect(options.count == 2)
        #expect(options.contains { $0.kind == .github && $0.projectId == "o/n" && $0.isActive })
        #expect(options.contains { $0.kind == .gitlab && $0.projectId == "7" && !$0.isActive })
    }
}
