import SwiftUI
import XCTest
@testable import LlmIdeMacLib

/// `IssueSeamRegistry` / `ProjectMemoryRegistry` / `TerminalPanelRegistry`
/// contract: features reach Issues' picker + recent issues, Explorer's project
/// memory viewer and the Terminal dock only through these Core seams, which
/// Shell fills at boot when the owning feature is compiled in. So an empty
/// registry must answer exactly what a compiled-out feature did (an empty
/// view, no issues) without crashing, an install must replace, and every
/// request field must reach the installed maker untouched. Fresh instances
/// per test — never `.shared`, which the app's boot path fills.
@MainActor
final class FeatureSeamRegistriesTests: XCTestCase {
    private let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")

    // MARK: - Issues

    private func makeTarget() -> (CodeWorkflowTarget, () -> Void) {
        let suite = "FeatureSeamRegistriesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let config = AppConfig(userDefaults: defaults)
        let target = CodeWorkflowTarget.gitLab(
            SavedGitLabProject(url: "https://gitlab.com/acme/widgets", displayName: "widgets",
                               resolvedId: 7, isActive: true),
            config: config)
        return (target, { defaults.removePersistentDomain(forName: suite) })
    }

    private func makeRequest(_ target: CodeWorkflowTarget,
                             onCancel: @escaping () -> Void = {}) -> ExistingIssuePickerRequest {
        ExistingIssuePickerRequest(backend: target.backend, projectId: target.projectId,
                                   displayName: target.displayName, isResolved: target.isResolved,
                                   onSelect: { _ in }, onCancel: onCancel)
    }

    func testIssuePickerFallbackWhenNothingInstalled() {
        let (target, cleanup) = makeTarget()
        defer { cleanup() }
        let registry = IssueSeamRegistry()
        XCTAssertFalse(registry.isPickerInstalled)
        // Must return the compiled-out empty view rather than trap.
        _ = registry.makePicker(makeRequest(target))
    }

    func testIssuePickerInstallReplacesAndPassesFieldsThrough() {
        let (target, cleanup) = makeTarget()
        defer { cleanup() }
        let registry = IssueSeamRegistry()
        var firstCalls = 0
        var seen: ExistingIssuePickerRequest?
        registry.installPicker { _ in firstCalls += 1; return AnyView(EmptyView()) }
        registry.installPicker { request in seen = request; return AnyView(EmptyView()) }
        var cancelled = false

        _ = registry.makePicker(makeRequest(target, onCancel: { cancelled = true }))

        XCTAssertTrue(registry.isPickerInstalled)
        XCTAssertEqual(firstCalls, 0, "a replaced maker must never run")
        XCTAssertEqual(seen?.projectId, target.projectId)
        XCTAssertEqual(seen?.displayName, target.displayName)
        XCTAssertEqual(seen?.isResolved, target.isResolved)
        seen?.onCancel()
        XCTAssertTrue(cancelled, "the caller's callbacks must reach the picker unchanged")
    }

    func testRecentIssuesAreEmptyWhenNothingInstalled() async throws {
        let registry = IssueSeamRegistry()
        let (config, store, cleanup) = try makeConfigAndStore()
        defer { cleanup() }
        XCTAssertFalse(registry.isRecentIssuesInstalled)
        let context = await registry.recentIssuesContext(config: config, projectStore: store)
        let refreshed = await registry.refreshRecentIssues(config: config, projectStore: store)
        XCTAssertEqual(context, [])
        XCTAssertEqual(refreshed, [])
    }

    func testRecentIssuesRouteToTheMatchingProviderCall() async throws {
        let registry = IssueSeamRegistry()
        let provider = FakeRecentIssues()
        registry.installRecentIssues(provider)
        let (config, store, cleanup) = try makeConfigAndStore()
        defer { cleanup() }

        let context = await registry.recentIssuesContext(config: config, projectStore: store)
        let refreshed = await registry.refreshRecentIssues(config: config, projectStore: store)

        XCTAssertTrue(registry.isRecentIssuesInstalled)
        XCTAssertEqual(context.map(\.iid), [1], "context reads must be the cache-first call")
        XCTAssertEqual(refreshed.map(\.iid), [2], "refresh must bypass the cache")
        XCTAssertEqual(provider.calls, ["context", "fetch"])
    }

    private func makeConfigAndStore() throws -> (AppConfig, ProjectStore, () -> Void) {
        let suite = "FeatureSeamRegistriesTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("FeatureSeamRegistriesTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (AppConfig(userDefaults: defaults), ProjectStore(stateDirectory: dir), {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: dir)
        })
    }

    // MARK: - Project memory

    func testProjectMemoryFallbackAndPassThrough() {
        let registry = ProjectMemoryRegistry()
        let request = ProjectMemoryRequest(api: api, repos: ["~/src/widgets"],
                                           workspaceRoot: "~/src", sessionId: "abc")
        XCTAssertFalse(registry.isInstalled)
        _ = registry.make(request)

        var firstCalls = 0
        var seen: ProjectMemoryRequest?
        registry.install { _ in firstCalls += 1; return AnyView(EmptyView()) }
        registry.install { request in seen = request; return AnyView(EmptyView()) }
        _ = registry.make(request)

        XCTAssertTrue(registry.isInstalled)
        XCTAssertEqual(firstCalls, 0, "a replaced maker must never run")
        XCTAssertEqual(seen?.repos, ["~/src/widgets"])
        XCTAssertEqual(seen?.workspaceRoot, "~/src")
        XCTAssertEqual(seen?.sessionId, "abc")
        XCTAssertTrue(seen?.api === api)
    }

    // MARK: - Terminal

    func testTerminalPanelFallbackAndPassThrough() {
        let registry = TerminalPanelRegistry()
        let directory = URL(fileURLWithPath: "/tmp/project")
        XCTAssertFalse(registry.isInstalled)
        _ = registry.make(projectDirectory: directory)

        var firstCalls = 0
        var seen: URL?
        registry.install { _ in firstCalls += 1; return AnyView(EmptyView()) }
        registry.install { url in seen = url; return AnyView(EmptyView()) }
        _ = registry.make(projectDirectory: directory)

        XCTAssertTrue(registry.isInstalled)
        XCTAssertEqual(firstCalls, 0, "a replaced maker must never run")
        XCTAssertEqual(seen, directory)
    }
}

@MainActor
private final class FakeRecentIssues: RecentIssuesProviding {
    private(set) var calls: [String] = []

    private func issue(_ iid: Int) -> AgentContext.RecentIssue {
        AgentContext.RecentIssue(iid: iid, title: "Issue \(iid)", state: "opened", labels: [],
                                 snippet: nil, updatedAt: nil)
    }

    func contextIssues(config: AppConfig, projectStore: ProjectStore) async -> [AgentContext.RecentIssue] {
        calls.append("context")
        return [issue(1)]
    }

    func fetch(config: AppConfig, projectStore: ProjectStore) async -> [AgentContext.RecentIssue] {
        calls.append("fetch")
        return [issue(2)]
    }
}
