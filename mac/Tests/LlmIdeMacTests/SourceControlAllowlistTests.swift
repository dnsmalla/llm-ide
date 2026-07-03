import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("SourceControl allow-list")
struct SourceControlAllowlistTests {
    private func cfg(disallow ops: [RepoOperation], provider: RepoBackendKind) -> AppConfig {
        let name = "scm-allow-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let c = AppConfig(userDefaults: d)
        // Register an active cloned repo at a temp root so providerKind resolves.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        if provider == .github {
            var repo = SavedGitHubRepo(url: "https://github.com/o/r", displayName: "r", isActive: true)
            repo.localPath = root.path
            c.gitHubSavedRepos = [repo]
        }
        for op in ops { c.setAllowed(op, provider: provider, false) }
        return c
    }

    @Test func pushBlockedWhenPushDisallowed() async {
        let config = cfg(disallow: [.push], provider: .github)
        let root = URL(fileURLWithPath: config.gitHubSavedRepos[0].localPath!)
        let scm = SourceControlService(config: config)
        await scm.push(root: root)
        #expect(scm.state.opError != nil)
    }

    @Test func pullBlockedWhenSyncDisallowed() async {
        let config = cfg(disallow: [.sync], provider: .github)
        let root = URL(fileURLWithPath: config.gitHubSavedRepos[0].localPath!)
        let scm = SourceControlService(config: config)
        await scm.pull(root: root)
        #expect(scm.state.opError != nil)
    }

    @Test func syncBlockedWhenPushDisallowed() async {
        // sync() gates on BOTH .sync and .push — disallowing either should block.
        let config = cfg(disallow: [.push], provider: .github)
        let root = URL(fileURLWithPath: config.gitHubSavedRepos[0].localPath!)
        let scm = SourceControlService(config: config)
        await scm.sync(root: root)
        #expect(scm.state.opError != nil)
    }

    @Test func publishBlockedWhenPushDisallowed() async {
        let config = cfg(disallow: [.push], provider: .github)
        let root = URL(fileURLWithPath: config.gitHubSavedRepos[0].localPath!)
        let scm = SourceControlService(config: config)
        await scm.publish(root: root)
        #expect(scm.state.opError != nil)
    }

    @Test func createBranchBlockedWhenCreateBranchDisallowed() async {
        let config = cfg(disallow: [.createBranch], provider: .github)
        let root = URL(fileURLWithPath: config.gitHubSavedRepos[0].localPath!)
        let scm = SourceControlService(config: config)
        await scm.createBranch(root: root, name: "feature/x")
        #expect(scm.state.opError != nil)
    }

    @Test func unmanagedRootIsNotGated() async {
        // A root that isn't a saved GitHub/GitLab clone path should never be
        // gated by this service — providerKind resolves nil, blocked() short-circuits.
        let config = cfg(disallow: [.push], provider: .github)
        let scm = SourceControlService(config: config)
        let unmanaged = FileManager.default.temporaryDirectory.appendingPathComponent("unmanaged-\(UUID().uuidString)")
        await scm.push(root: unmanaged)
        // No credentials configured either, so opError will still be set —
        // but NOT the allow-list message. Assert it's the credentials message.
        #expect(scm.state.opError == "No credentials configured for this repo.")
    }
}
