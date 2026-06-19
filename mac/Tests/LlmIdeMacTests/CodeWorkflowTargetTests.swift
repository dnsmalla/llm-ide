import Testing
import Foundation
@testable import LlmIdeMac

/// Covers the backend selection logic that lets the Code-change sheets drive
/// GitHub as well as GitLab: the per-provider factories and the active-repo
/// resolver (GitLab-first precedence, cloned-only).
@MainActor
@Suite("CodeWorkflowTarget resolution")
struct CodeWorkflowTargetTests {

    private func freshConfig() -> AppConfig {
        AppConfig(userDefaults: UserDefaults(suiteName: "cwtarget-\(UUID().uuidString)")!)
    }

    private func gitLab(active: Bool, cloned: Bool) -> SavedGitLabProject {
        var p = SavedGitLabProject(url: "https://gitlab.com/acme/app",
                                   displayName: "App", resolvedId: 42, isActive: active)
        if cloned { p.localPath = "/tmp/app"; p.defaultBranch = "trunk" }
        return p
    }

    private func gitHub(active: Bool, cloned: Bool) -> SavedGitHubRepo {
        var r = SavedGitHubRepo(url: "acme/web", displayName: "Web", resolvedId: 7, isActive: active)
        if cloned { r.localPath = "/tmp/web"; r.defaultBranch = "main" }
        return r
    }

    @Test func gitLabFactoryMapsFields() {
        let cfg = freshConfig()
        let t = CodeWorkflowTarget.gitLab(gitLab(active: true, cloned: true), config: cfg)
        #expect(t.kind == .gitlab)
        #expect(t.projectId == "42")
        #expect(t.isResolved)
        #expect(t.defaultBranch == "trunk")
        #expect(t.localURL.path == "/tmp/app")
        #expect(t.displayName == "App")
    }

    @Test func gitHubFactoryUsesOwnerNameProjectId() {
        let cfg = freshConfig()
        let t = CodeWorkflowTarget.gitHub(gitHub(active: true, cloned: true), config: cfg)
        #expect(t.kind == .github)
        #expect(t.projectId == "acme/web")
        #expect(t.isResolved)
        #expect(t.defaultBranch == "main")
        #expect(t.localURL.path == "/tmp/web")
    }

    @Test func gitLabUnresolvedProjectIsNotResolved() {
        let cfg = freshConfig()
        var p = SavedGitLabProject(url: "https://gitlab.com/acme/app", displayName: "App", isActive: true)
        p.localPath = "/tmp/app"   // cloned but resolvedId nil
        let t = CodeWorkflowTarget.gitLab(p, config: cfg)
        #expect(!t.isResolved)
        #expect(t.projectId == "0")
    }

    @Test func resolveActivePrefersGitLab() {
        let cfg = freshConfig()
        cfg.gitLabSavedProjects = [gitLab(active: true, cloned: true)]
        cfg.gitHubSavedRepos = [gitHub(active: true, cloned: true)]
        let t = CodeWorkflowTarget.resolveActive(config: cfg)
        #expect(t?.kind == .gitlab)
    }

    @Test func resolveActiveFallsBackToGitHub() {
        let cfg = freshConfig()
        cfg.gitLabSavedProjects = [gitLab(active: true, cloned: false)]  // active but not cloned
        cfg.gitHubSavedRepos = [gitHub(active: true, cloned: true)]
        let t = CodeWorkflowTarget.resolveActive(config: cfg)
        #expect(t?.kind == .github)
    }

    @Test func resolveActiveNilWhenNoneCloned() {
        let cfg = freshConfig()
        cfg.gitLabSavedProjects = [gitLab(active: true, cloned: false)]
        cfg.gitHubSavedRepos = [gitHub(active: true, cloned: false)]
        #expect(CodeWorkflowTarget.resolveActive(config: cfg) == nil)
        #expect(!CodeWorkflowTarget.hasActive(config: cfg))
    }

    @Test func hasActiveTrueWhenCloned() {
        let cfg = freshConfig()
        cfg.gitHubSavedRepos = [gitHub(active: true, cloned: true)]
        #expect(CodeWorkflowTarget.hasActive(config: cfg))
    }
}
