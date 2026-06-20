import Testing
import Foundation
@testable import LlmIdeMac

struct WorkspaceRootTests {
    private let project = "/tmp/llm-project"
    private let repo = URL(fileURLWithPath: "/tmp/clones/some-repo")

    @Test func prefersProjectOverGlobalRepo() {
        // Both exist → the active project wins (the bug fix: a fresh project
        // must not inherit the globally-active repo).
        let root = WorkspaceRoot.pick(projectPath: project, fallbackRepo: repo, exists: { _ in true })
        #expect(root?.path == project)
    }

    @Test func fallsBackToRepoWhenNoProject() {
        let root = WorkspaceRoot.pick(projectPath: nil, fallbackRepo: repo, exists: { _ in true })
        #expect(root == repo)
    }

    @Test func fallsBackToRepoWhenProjectPathMissingOnDisk() {
        // Project recorded but its folder no longer exists → use the repo.
        let root = WorkspaceRoot.pick(projectPath: project, fallbackRepo: repo,
                                      exists: { $0 == repo })
        #expect(root == repo)
    }

    @Test func emptyProjectPathIsIgnored() {
        let root = WorkspaceRoot.pick(projectPath: "", fallbackRepo: repo, exists: { _ in true })
        #expect(root == repo)
    }

    @Test func nilWhenNothingResolves() {
        #expect(WorkspaceRoot.pick(projectPath: nil, fallbackRepo: nil, exists: { _ in true }) == nil)
        #expect(WorkspaceRoot.pick(projectPath: project, fallbackRepo: repo, exists: { _ in false }) == nil)
    }
}
