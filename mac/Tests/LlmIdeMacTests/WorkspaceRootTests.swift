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

    // MARK: - Git working tree (the second root)

    private let projectURL = URL(fileURLWithPath: "/tmp/llm-project")
    private let clone = URL(fileURLWithPath: "/tmp/llm-project/code/some-repo")

    @Test func gitRootIsProjectWhenProjectIsItselfARepo() {
        // project-IS-a-repo (linkedRepo) model: the project root has .git.
        let git = WorkspaceRoot.pickGitRoot(projectRoot: projectURL, activeClone: clone,
                                            isGitRepo: { $0 == projectURL })
        #expect(git == projectURL)
    }

    @Test func gitRootIsActiveCloneWhenProjectIsNotARepo() {
        // clone-into-code model: project root is a plain workspace folder; the
        // working tree is the clone under code/.
        let git = WorkspaceRoot.pickGitRoot(projectRoot: projectURL, activeClone: clone,
                                            isGitRepo: { $0 == clone })
        #expect(git == clone)
    }

    @Test func gitRootPrefersProjectOverCloneWhenBothAreRepos() {
        let git = WorkspaceRoot.pickGitRoot(projectRoot: projectURL, activeClone: clone,
                                            isGitRepo: { _ in true })
        #expect(git == projectURL)
    }

    @Test func gitRootNilWhenNoWorkingTreeExists() {
        // A fresh project with no clone yet → no working tree (SCM shows empty).
        #expect(WorkspaceRoot.pickGitRoot(projectRoot: projectURL, activeClone: clone,
                                          isGitRepo: { _ in false }) == nil)
        #expect(WorkspaceRoot.pickGitRoot(projectRoot: projectURL, activeClone: nil,
                                          isGitRepo: { _ in false }) == nil)
    }
}
