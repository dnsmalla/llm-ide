import Testing
import Foundation
@testable import LlmIdeMac

/// Orchestration tests for CodeWorkflowService, unblocked by re-typing it onto
/// RepoBackend (it was previously GitLab-concrete and unmockable). Exercises
/// the backend-neutral logic — issue bootstrap field mapping, MR dedup on
/// retry, and the once-only / state-aware issue close — with a mock backend.
@MainActor
@Suite("CodeWorkflowService orchestration")
struct CodeWorkflowServiceTests {

    // MARK: - Mock backend

    final class MockBackend: RepoBackend {
        nonisolated var kind: RepoBackendKind { .github }
        nonisolated var canWriteIssues: Bool { true }
        nonisolated var canCreateMergeRequests: Bool { true }

        // Configurable returns
        var issuesByNumber: [Int: RepoIssue] = [:]
        var openMRs: [RepoMergeRequest] = []

        // Call records
        var createdMRCount = 0
        var updatedIssues: [(number: Int, close: Bool)] = []
        var createdNotes: [String] = []

        func listProjects() async throws -> [RepoProject] { [] }
        func getProject(id: String) async throws -> RepoProject { throw Err.unset }
        func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] { [] }
        func getIssue(projectId: String, number: Int) async throws -> RepoIssue {
            guard let i = issuesByNumber[number] else { throw Err.unset }
            return i
        }
        func listLabels(projectId: String) async throws -> [RepoLabel] { [] }
        func listMilestones(projectId: String) async throws -> [RepoMilestone] { [] }
        func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue { throw Err.unset }
        func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue {
            updatedIssues.append((number, payload.stateChange == .close))
            // Reflect the close in the stored issue so a re-read sees "closed".
            if let cur = issuesByNumber[number], payload.stateChange == .close {
                issuesByNumber[number] = makeIssue(number: number, title: cur.title, state: "closed")
            }
            return issuesByNumber[number] ?? makeIssue(number: number, title: "", state: "closed")
        }
        func listNotes(projectId: String, number: Int) async throws -> [RepoNote] { [] }
        func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote {
            createdNotes.append(body)
            return RepoNote(id: "n", body: body, author: Self.user, createdAt: "", isSystem: false)
        }
        func createBranch(projectId: String, name: String, ref: String) async throws -> Bool { true }
        func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest {
            createdMRCount += 1
            return RepoMergeRequest(id: "m", number: 999, title: payload.title, state: "opened",
                                    sourceBranch: payload.sourceBranch, targetBranch: payload.targetBranch,
                                    webUrl: "https://example.test/mr/999", isDraft: payload.draft)
        }
        func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] { openMRs }

        enum Err: Error { case unset }
        static let user = RepoUser(id: "u", username: "u", displayName: "U", avatarUrl: nil)
    }

    static func makeIssue(number: Int, title: String, state: String, body: String? = nil) -> RepoIssue {
        RepoIssue(id: "i\(number)", number: number, title: title, body: body, state: state,
                  labels: [], milestone: nil, assignees: [], author: MockBackend.user,
                  createdAt: "", updatedAt: "", closedAt: nil,
                  webUrl: "https://example.test/issues/\(number)", commentCount: 0, dueDate: nil)
    }

    private func makeService(_ backend: MockBackend) -> CodeWorkflowService {
        CodeWorkflowService(
            backend: backend,
            projectId: "owner/repo",
            localURL: URL(fileURLWithPath: "/tmp/repo"),
            defaultBranch: "main",
            displayName: "owner/repo",
            gitPushToken: { "tok" },
            api: LlmIdeAPIClient(baseURL: "https://example.test"))
    }

    // MARK: - Tests

    @Test func bootstrapMapsIssueFieldsAndAdvancesToBranch() async {
        let backend = MockBackend()
        backend.issuesByNumber[42] = Self.makeIssue(number: 42, title: "Fix the bug", state: "opened", body: "details")
        let svc = makeService(backend)

        await svc.bootstrapFromExistingIssue(number: 42, plan: "the plan")

        #expect(svc.stepError == nil)
        #expect(svc.createdIssue?.number == 42)
        #expect(svc.issueTitle == "Fix the bug")
        #expect(svc.issueDescription == "details")
        #expect(svc.commitMessage.contains("closes #42"))
        #expect(svc.mrTitle == "Fix the bug")
        #expect(svc.currentStep == .branch)
    }

    @Test func retryMRAdoptsExistingMRForBranchInsteadOfCreating() async {
        let backend = MockBackend()
        backend.issuesByNumber[7] = Self.makeIssue(number: 7, title: "T", state: "opened")
        let svc = makeService(backend)
        await svc.bootstrapFromExistingIssue(number: 7, plan: "p")  // sets createdIssue + branchName
        backend.openMRs = [RepoMergeRequest(id: "m1", number: 5, title: "existing", state: "opened",
                                            sourceBranch: svc.branchName, targetBranch: "main",
                                            webUrl: "https://example.test/mr/5", isDraft: false)]

        await svc.retryMROnly()

        #expect(svc.createdMR?.number == 5)          // adopted the existing MR
        #expect(backend.createdMRCount == 0)          // did NOT create a duplicate
        #expect(backend.createdNotes.count == 1)      // posted the summary comment
    }

    @Test func closeIssueIsIdempotentAndStateAware() async {
        let backend = MockBackend()
        backend.issuesByNumber[3] = Self.makeIssue(number: 3, title: "T", state: "opened")
        let svc = makeService(backend)
        await svc.bootstrapFromExistingIssue(number: 3, plan: "p")

        await svc.closeIssueIfNeeded()
        #expect(svc.issueClosedSuccessfully == true)
        #expect(backend.updatedIssues.filter { $0.close }.count == 1)

        // Second call must NOT close again (doneCloseFired guard).
        await svc.closeIssueIfNeeded()
        #expect(backend.updatedIssues.filter { $0.close }.count == 1)
    }

    @Test func closeIssueSkipsWhenAlreadyClosed() async {
        let backend = MockBackend()
        backend.issuesByNumber[9] = Self.makeIssue(number: 9, title: "T", state: "closed")
        let svc = makeService(backend)
        await svc.bootstrapFromExistingIssue(number: 9, plan: "p")

        await svc.closeIssueIfNeeded()
        #expect(svc.issueClosedSuccessfully == true)         // not an error
        #expect(backend.updatedIssues.isEmpty)               // but no close call (already closed)
    }
}
