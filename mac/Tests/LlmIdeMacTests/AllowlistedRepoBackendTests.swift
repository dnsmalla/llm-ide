import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("AllowlistedRepoBackend")
struct AllowlistedRepoBackendTests {

    // Minimal mock: records the last write called; reads return empties.
    final class Spy: RepoBackend {
        nonisolated var kind: RepoBackendKind { .github }
        var canWriteIssues = true; var canCreateMergeRequests = true
        var supportsWeight = false; var usesScheduleOverlay = true
        var lastWrite: String?
        func listProjects() async throws -> [RepoProject] { [] }
        func getProject(id: String) async throws -> RepoProject { throw CancellationError() }
        func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] { [] }
        func getIssue(projectId: String, number: Int) async throws -> RepoIssue { throw CancellationError() }
        func listLabels(projectId: String) async throws -> [RepoLabel] { [] }
        func listMilestones(projectId: String) async throws -> [RepoMilestone] { [] }
        func listMembers(projectId: String) async throws -> [RepoUser] { [] }
        func listNotes(projectId: String, number: Int) async throws -> [RepoNote] { [] }
        func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] { [] }
        func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue { lastWrite = "createIssue"; throw CancellationError() }
        func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue { lastWrite = "updateIssue"; throw CancellationError() }
        func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote { lastWrite = "createNote"; throw CancellationError() }
        func createBranch(projectId: String, name: String, ref: String) async throws -> Bool { lastWrite = "createBranch"; return true }
        func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest { lastWrite = "createMR"; throw CancellationError() }
    }

    private func config(disallow ops: [RepoOperation]) -> AppConfig {
        let name = "allowlisted-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!; d.removePersistentDomain(forName: name)
        let c = AppConfig(userDefaults: d)
        for op in ops { c.setAllowed(op, provider: .github, false) }
        return c
    }

    @Test func createIssueThrowsWhenDisallowed() async {
        let spy = Spy()
        let g = AllowlistedRepoBackend(wrapping: spy, config: config(disallow: [.createIssue]))
        await #expect(throws: RepoBackendError.self) {
            _ = try await g.createIssue(projectId: "1", payload: RepoIssuePayload(title: "x"))
        }
        #expect(spy.lastWrite == nil, "must not reach the wrapped backend")
    }

    @Test func createBranchDelegatesWhenAllowed() async throws {
        let spy = Spy()
        let g = AllowlistedRepoBackend(wrapping: spy, config: config(disallow: []))
        _ = try await g.createBranch(projectId: "1", name: "b", ref: "main")
        #expect(spy.lastWrite == "createBranch")
    }

    @Test func updateIssueRoutesToCloseVsEdit() async {
        let spy = Spy()
        // .closeIssue disallowed, .editIssue allowed.
        let g = AllowlistedRepoBackend(wrapping: spy, config: config(disallow: [.closeIssue]))
        // stateChange present → gated as .closeIssue → throws.
        await #expect(throws: RepoBackendError.self) {
            _ = try await g.updateIssue(projectId: "1", number: 1, payload: RepoIssuePayload(title: "x", stateChange: .close))
        }
        #expect(spy.lastWrite == nil)
        // metadata-only → gated as .editIssue → allowed → reaches backend.
        _ = try? await g.updateIssue(projectId: "1", number: 1, payload: RepoIssuePayload(title: "x", labels: ["bug"]))
        #expect(spy.lastWrite == "updateIssue")
    }
}
