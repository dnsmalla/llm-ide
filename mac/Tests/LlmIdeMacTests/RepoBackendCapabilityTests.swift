import Testing
import RepoKit
import Foundation
@testable import LlmIdeMac

@MainActor
struct RepoBackendCapabilityTests {
    private func cfg() -> AppConfig {
        AppConfig(userDefaults: UserDefaults(suiteName: "captest-\(UUID().uuidString)")!)
    }

    @Test func gitlabCapabilities() {
        let c = GitLabClient(config: cfg())
        #expect(c.supportsWeight == true)
        #expect(c.usesScheduleOverlay == false)
    }

    @Test func githubCapabilities() {
        let c = GitHubClient(config: cfg())
        #expect(c.supportsWeight == false)
        #expect(c.usesScheduleOverlay == true)
    }

    @Test func weightThreadsThroughBumping() {
        let issue = RepoIssue(
            id: "1", number: 1, title: "t", body: nil, state: "opened",
            labels: [], milestone: nil, assignees: [],
            author: RepoUser(id: "u", username: "u", displayName: "u", avatarUrl: nil),
            createdAt: "", updatedAt: "", closedAt: nil, webUrl: "",
            commentCount: 0, dueDate: nil, weight: 3)
        #expect(issue.weight == 3)
        #expect(issue.bumping(commentCount: 1).weight == 3)
    }
}
