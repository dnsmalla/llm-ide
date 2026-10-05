import Testing
import Foundation
@testable import LlmIdeMacLib

/// Shipping a Loop's edits: a new branch, a commit of exactly those files, a
/// push, a merge request against the default branch — and never anything on the
/// default branch itself.
@MainActor
@Suite("Change shipping")
struct ChangeShippingTests {
    struct Boom: LocalizedError { let text: String; var errorDescription: String? { text } }

    /// Records every git command and answers from `handler`.
    final class FakeGit: ShipGitOperating {
        var calls: [[String]] = []
        var branch = "main"
        var pushed: [String] = []
        var pushError: Error?
        var handler: ([String]) throws -> String = { _ in "" }
        func git(_ args: [String], at root: URL) async throws -> String { calls.append(args); return try handler(args) }
        func currentBranch(at root: URL) async throws -> String { branch }
        func push(branch: String, at root: URL) async throws { if let pushError { throw pushError }; pushed.append(branch) }
        func ran(_ prefix: [String]) -> Bool { calls.contains { Array($0.prefix(prefix.count)) == prefix } }
    }

    struct Unsupported: Error {}
    /// The two backend calls a shipment makes; everything else is not used.
    final class FakeBackend: RepoBackend, @unchecked Sendable {
        var open: [RepoMergeRequest] = []
        var created: [RepoMergeRequestPayload] = []
        var createError: Error?
        var kind: RepoBackendKind { .gitlab }
        func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest] { open }
        func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest {
            if let createError { throw createError }
            created.append(payload)
            return RepoMergeRequest(id: "9", number: 9, title: payload.title, state: "opened",
                                    sourceBranch: payload.sourceBranch, targetBranch: payload.targetBranch,
                                    webUrl: "https://gitlab.example/p/-/merge_requests/9", isDraft: false)
        }
        func listProjects() async throws -> [RepoProject] { throw Unsupported() }
        func getProject(id: String) async throws -> RepoProject { throw Unsupported() }
        func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue] { throw Unsupported() }
        func getIssue(projectId: String, number: Int) async throws -> RepoIssue { throw Unsupported() }
        func listLabels(projectId: String) async throws -> [RepoLabel] { throw Unsupported() }
        func listMilestones(projectId: String) async throws -> [RepoMilestone] { throw Unsupported() }
        func listMembers(projectId: String) async throws -> [RepoUser] { throw Unsupported() }
        var canWriteIssues: Bool { false }
        var canCreateMergeRequests: Bool { true }
        var supportsWeight: Bool { false }
        var usesScheduleOverlay: Bool { false }
        var filtersSearchServerSide: Bool { false }
        func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue { throw Unsupported() }
        func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue { throw Unsupported() }
        func listNotes(projectId: String, number: Int) async throws -> [RepoNote] { throw Unsupported() }
        func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote { throw Unsupported() }
        func createBranch(projectId: String, name: String, ref: String) async throws -> Bool { throw Unsupported() }
    }

    private let request = ShipRequest(
        gitRoot: URL(fileURLWithPath: "/tmp/repo"), paths: ["src/a.py", "new.py"],
        branchPrefix: "loop/regression", commitMessage: "fix: loop", title: "Loop fix", description: "details")

    private func shipper(_ git: FakeGit, _ backend: FakeBackend,
                         allowed: @escaping (RepoOperation) -> Bool = { _ in true }) -> GitChangeShipper {
        GitChangeShipper(git: git, backend: backend, projectId: "42", defaultBranchHint: nil, isAllowed: allowed,
                         now: { Date(timeIntervalSince1970: 1_791_000_000) })
    }

    /// A repo with no merge in progress, on `main`, whose default branch is main.
    private func happyGit() -> FakeGit {
        let git = FakeGit()
        git.handler = { args in
            switch args.first {
            case "rev-parse": throw Boom(text: "no such marker")
            case "symbolic-ref": return "refs/remotes/origin/main\n"
            case "status": return " M src/a.py\n?? new.py\n"
            default: return ""
            }
        }
        return git
    }

    @Test("the happy path: new branch, scoped commit, push, request against main, back on main")
    func shipped() async throws {
        let git = happyGit(); let backend = FakeBackend()
        let outcome = await shipper(git, backend).ship(request)
        guard case .shipped(let branch, let url, let number, let left) = outcome else { Issue.record("\(outcome)"); return }
        #expect(branch.hasPrefix("loop/regression-"))
        #expect(url.hasSuffix("/merge_requests/9") && number == 9 && !left)
        #expect(git.pushed == [branch])
        #expect(git.ran(["switch", "-c", branch]))
        #expect(git.ran(["add", "--", "new.py"]), "only the untracked path is added")
        // The pathspec confines the commit to the run's files.
        #expect(git.calls.contains(["commit", "-m", "fix: loop", "--", "src/a.py", "new.py"]))
        #expect(git.calls.last == ["switch", "main"], "the user's branch is checked out again")
        #expect(backend.created.count == 1)
        #expect(backend.created[0].targetBranch == "main")
        #expect(backend.created[0].sourceBranch == branch)
    }

    @Test("nothing leaves the machine unless every operation is allowed")
    func permissions() async {
        for blocked in ShipPlanning.requiredOperations {
            let git = happyGit(); let backend = FakeBackend()
            let outcome = await shipper(git, backend, allowed: { $0 != blocked }).ship(request)
            guard case .skipped(let reason) = outcome else { Issue.record("\(blocked): \(outcome)"); continue }
            #expect(reason.contains(blocked.label))
            #expect(git.calls.isEmpty && git.pushed.isEmpty && backend.created.isEmpty, "\(blocked) gates everything")
        }
    }

    @Test("an earlier request that is still open does not stop the next one: each shipment is its own")
    func eachShipmentIsItsOwn() async {
        let backend = FakeBackend()
        backend.open = [RepoMergeRequest(id: "5", number: 5, title: "t", state: "opened",
                                         sourceBranch: "loop/regression-20261001-000000", targetBranch: "main",
                                         webUrl: "https://gitlab.example/5", isDraft: false)]
        let git = happyGit()
        guard case .shipped(let branch, _, _, _) = await shipper(git, backend).ship(request) else {
            Issue.record("an open request from the same loop must not block a new one"); return
        }
        #expect(branch != "loop/regression-20261001-000000")
        #expect(backend.created.count == 1)
        // The shipment never needed to look at the open list.
        #expect(git.ran(["switch", "-c", branch]))
    }

    @Test("a failed commit puts the user back, removes the empty branch and pushes nothing")
    func commitFails() async {
        let git = happyGit(); let backend = FakeBackend()
        let base = git.handler
        git.handler = { args in if args.first == "commit" { throw Boom(text: "hook rejected") }; return try base(args) }
        let outcome = await shipper(git, backend).ship(request)
        guard case .failed(let step, let message) = outcome else { Issue.record("\(outcome)"); return }
        #expect(step == .commit && message.contains("hook rejected"))
        #expect(git.ran(["restore", "--staged", "--", "new.py"]), "what this method added is unstaged again")
        #expect(git.calls.contains(["switch", "main"]))
        #expect(git.calls.contains { $0.first == "branch" && $0.contains("-D") })
        #expect(git.pushed.isEmpty && backend.created.isEmpty)
    }

    @Test("a failed push keeps the commit on the local branch and creates no request")
    func pushFails() async {
        let git = happyGit(); let backend = FakeBackend()
        git.pushError = Boom(text: "network down")
        let outcome = await shipper(git, backend).ship(request)
        guard case .failed(let step, let message) = outcome else { Issue.record("\(outcome)"); return }
        #expect(step == .push && message.contains("network down") && message.contains("local branch loop/regression-"))
        #expect(git.calls.last == ["switch", "main"])
        #expect(backend.created.isEmpty)
    }

    @Test("a failed request creation says the branch is pushed")
    func mergeRequestFails() async {
        let git = happyGit(); let backend = FakeBackend()
        backend.createError = Boom(text: "403")
        let outcome = await shipper(git, backend).ship(request)
        guard case .failed(let step, let message) = outcome else { Issue.record("\(outcome)"); return }
        #expect(step == .mergeRequest && message.contains("is pushed"))
        #expect(git.pushed.count == 1)
    }

    @Test("a merge in progress and a detached HEAD stop it early")
    func guards() async {
        let merging = happyGit()
        merging.handler = { args in if args.first == "rev-parse" { return "abc" }; return "" }
        if case .skipped(let reason) = await shipper(merging, FakeBackend()).ship(request) { #expect(reason.contains("merge")) }
        else { Issue.record("merge in progress") }

        let detached = happyGit(); detached.branch = "HEAD"
        if case .skipped(let reason) = await shipper(detached, FakeBackend()).ship(request) { #expect(reason.contains("detached")) }
        else { Issue.record("detached") }

        var empty = request; empty.paths = []
        if case .skipped = await shipper(happyGit(), FakeBackend()).ship(empty) {} else { Issue.record("no paths") }
    }

    @Test("planning: branch names, untracked parsing, default branch")
    func planning() {
        #expect(ShipPlanning.branchPrefix(for: "Regression") == "loop/regression")
        #expect(ShipPlanning.branchPrefix(for: "Doc Optimization!") == "loop/doc-optimization")
        #expect(ShipPlanning.branchPrefix(for: "日本語") == "loop/run", "nothing usable becomes a fixed word, never an empty ref")
        #expect(ShipPlanning.branchName(prefix: "loop/x", at: Date(timeIntervalSince1970: 0)) == "loop/x-19700101-000000")
        let porcelain = " M a.py\n?? new.py\n?? \"sp ace.py\"\n?? other.py\n"
        #expect(ShipPlanning.untrackedPaths(porcelain: porcelain, among: ["a.py", "new.py", "sp ace.py"]) == ["new.py", "sp ace.py"])
        #expect(ShipPlanning.defaultBranch(fromSymbolicRef: "refs/remotes/origin/develop\n") == "develop")
        #expect(ShipPlanning.defaultBranch(fromSymbolicRef: "garbage") == nil)
    }
}
