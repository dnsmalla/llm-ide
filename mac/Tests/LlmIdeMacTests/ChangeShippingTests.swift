import Testing
import Foundation
@testable import LlmIdeMacLib

/// Shipping a Loop's edits: ONE commit on top of origin/<default> holding exactly
/// the named files, built without touching the checkout, pushed to a new branch,
/// and a merge request opened against the default branch.
@MainActor
@Suite("Change shipping")
struct ChangeShippingTests {
    struct Boom: LocalizedError { let text: String; var errorDescription: String? { text } }

    /// Records every git command (with its extra environment) and answers from `handler`.
    final class FakeGit: ShipGitOperating {
        var calls: [(args: [String], env: [String: String])] = []
        var pushes: [(sha: String, branch: String)] = []
        var pushError: Error?
        var handler: ([String]) throws -> String = { _ in "" }
        func git(_ args: [String], at root: URL, environment: [String: String]) async throws -> String {
            calls.append((args, environment)); return try handler(args)
        }
        func pushCommit(sha: String, toBranch branch: String, at root: URL) async throws {
            if let pushError { throw pushError }; pushes.append((sha, branch))
        }
        func ran(_ prefix: [String]) -> Bool { calls.contains { Array($0.args.prefix(prefix.count)) == prefix } }
        func call(_ first: String) -> (args: [String], env: [String: String])? { calls.first { $0.args.first == first } }
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

    private func shipper(_ git: FakeGit, _ backend: FakeBackend, expectedRemote: String? = nil,
                         allowed: @escaping (RepoOperation) -> Bool = { _ in true }) -> GitChangeShipper {
        GitChangeShipper(git: git, backend: backend, projectId: "42", defaultBranchHint: nil,
                         expectedRemote: expectedRemote, isAllowed: allowed,
                         now: { Date(timeIntervalSince1970: 1_791_000_000) })
    }

    /// A repo whose origin is the saved project, on a branch equal to origin/main in the
    /// shipped files, where the files differ from main only in the working tree.
    private func happyGit() -> FakeGit {
        let git = FakeGit()
        git.handler = { args in
            switch args.first {
            case "remote": return "https://gitlab.example/g/p.git\n"
            case "symbolic-ref": return "refs/remotes/origin/main\n"
            case "rev-parse": return args.contains { $0.hasSuffix("^{tree}") } ? "basetree\n" : "basesha\n"
            case "diff": return ""
            case "write-tree": return "newtree\n"
            case "commit-tree": return "commitsha\n"
            default: return ""
            }
        }
        return git
    }

    /// Git commands that would change HEAD, the real index, the working tree or a local branch.
    private let checkoutMutators: Set<String> = ["switch", "checkout", "reset", "stash", "commit", "branch",
                                                 "restore", "merge", "rebase", "cherry-pick", "apply", "clean", "mv", "rm"]

    @Test("the happy path: a commit on origin/main built in a throwaway index, pushed by sha, one request")
    func shipped() async throws {
        let git = happyGit(); let backend = FakeBackend()
        let outcome = await shipper(git, backend).ship(request)
        guard case .shipped(let branch, let url, let number) = outcome else { Issue.record("\(outcome)"); return }
        #expect(branch.hasPrefix("loop/regression-") && number == 9 && url.hasSuffix("/merge_requests/9"))
        #expect(git.pushes.count == 1 && git.pushes[0].sha == "commitsha" && git.pushes[0].branch == branch)
        #expect(git.call("read-tree")?.args == ["read-tree", "basesha"])
        #expect(git.calls.contains { $0.args == ["add", "-A", "--", "src/a.py", "new.py"] }, "exactly the shipped paths")
        #expect(git.call("commit-tree")?.args == ["commit-tree", "newtree", "-p", "basesha", "-m", "fix: loop"])
        #expect(backend.created.count == 1 && backend.created[0].targetBranch == "main" && backend.created[0].sourceBranch == branch)
    }

    @Test("the user's checkout is never written, in any outcome")
    func neverTouchesTheCheckout() async {
        var all: [FakeGit] = []
        func record(_ git: FakeGit, _ backend: FakeBackend = FakeBackend()) async { _ = await shipper(git, backend).ship(request); all.append(git) }
        await record(happyGit())
        let pushFails = happyGit(); pushFails.pushError = Boom(text: "down"); await record(pushFails)
        let mrFails = happyGit(); let failing = FakeBackend(); failing.createError = Boom(text: "403"); await record(mrFails, failing)
        let commitFails = happyGit(); let base = commitFails.handler
        commitFails.handler = { args in if args.first == "commit-tree" { throw Boom(text: "no identity") }; return try base(args) }
        await record(commitFails)
        for git in all {
            for call in git.calls {
                #expect(!checkoutMutators.contains(call.args.first ?? ""), "\(call.args) would change the checkout")
                // The only git commands that write an index run against the throwaway one.
                if ["read-tree", "add", "write-tree"].contains(call.args.first ?? "") {
                    #expect(call.env["GIT_INDEX_FILE"]?.hasSuffix(".index") == true && call.env["GIT_INDEX_FILE"]?.contains("ship-") == true)
                }
                #expect(call.env["GIT_LITERAL_PATHSPECS"] == "1", "paths are names, not patterns")
            }
        }
    }

    @Test("nothing leaves the machine unless every operation is allowed")
    func permissions() async {
        for blocked in ShipPlanning.requiredOperations {
            let git = happyGit(); let backend = FakeBackend()
            let outcome = await shipper(git, backend, allowed: { $0 != blocked }).ship(request)
            guard case .skipped(let reason) = outcome else { Issue.record("\(blocked): \(outcome)"); continue }
            #expect(reason.contains(blocked.label))
            #expect(git.calls.isEmpty && git.pushes.isEmpty && backend.created.isEmpty, "\(blocked) gates everything")
        }
    }

    @Test("a credential or key in the list stops the whole shipment before git is touched")
    func secrets() async {
        var risky = request; risky.paths = ["src/a.py", ".env", "keys/server.pem"]
        let git = happyGit(); let backend = FakeBackend()
        guard case .skipped(let reason) = await shipper(git, backend).ship(risky) else { Issue.record("a secret was shipped"); return }
        #expect(reason.contains(".env") && reason.contains("secret"))
        #expect(git.calls.isEmpty && git.pushes.isEmpty && backend.created.isEmpty)
    }

    @Test("origin must be the project the folder is saved as")
    func remoteGuard() async {
        let git = happyGit(); let backend = FakeBackend()
        // origin is a fork of the saved project.
        git.handler = { args in args.first == "remote" ? "https://gitlab.example/someone-else/p.git\n" : "" }
        guard case .skipped(let reason) = await shipper(git, backend, expectedRemote: "https://gitlab.example/g/p").ship(request) else { Issue.record("a fork was pushed to"); return }
        #expect(reason.contains("someone-else") && git.pushes.isEmpty && backend.created.isEmpty)
        // The saved project matches origin in https and scp forms, with or without .git.
        for origin in ["https://gitlab.example/g/p.git", "git@gitlab.example:g/p.git", "https://oauth2:tok@gitlab.example/g/p/"] {
            let ok = happyGit(); let base = ok.handler
            ok.handler = { args in args.first == "remote" ? origin + "\n" : try base(args) }
            if case .shipped = await shipper(ok, FakeBackend(), expectedRemote: "https://gitlab.example/g/p").ship(request) {}
            else { Issue.record("\(origin) is the saved project") }
        }
    }

    @Test("no origin/<default> yet, a branch that differs from it, and an already-identical tree each stop it")
    func contentGuards() async {
        let noBase = happyGit(); let base1 = noBase.handler
        noBase.handler = { args in if args.first == "rev-parse", !args.contains(where: { $0.hasSuffix("^{tree}") }) { throw Boom(text: "unknown") }; return try base1(args) }
        if case .skipped(let reason) = await shipper(noBase, FakeBackend()).ship(request) { #expect(reason.contains("fetch")) } else { Issue.record("no base") }

        let ahead = happyGit(); let base2 = ahead.handler
        ahead.handler = { args in args.first == "diff" ? "src/a.py\n" : try base2(args) }
        let backend = FakeBackend()
        if case .skipped(let reason) = await shipper(ahead, backend).ship(request) { #expect(reason.contains("differs from origin/main") && reason.contains("src/a.py")) }
        else { Issue.record("a branch that differs from main must not be shipped") }
        #expect(backend.created.isEmpty && ahead.pushes.isEmpty && !ahead.ran(["read-tree"]))

        let same = happyGit(); let base3 = same.handler
        same.handler = { args in args.first == "write-tree" ? "basetree\n" : try base3(args) }
        if case .skipped(let reason) = await shipper(same, FakeBackend()).ship(request) { #expect(reason.contains("already match")) } else { Issue.record("identical") }
        #expect(!same.ran(["commit-tree"]) && same.pushes.isEmpty)
    }

    @Test("a failed commit-tree creates nothing; a failed push or request says the checkout is untouched")
    func failures() async {
        let commitFails = happyGit(); let base = commitFails.handler
        commitFails.handler = { args in if args.first == "commit-tree" { throw Boom(text: "no identity") }; return try base(args) }
        if case .failed(let step, let message) = await shipper(commitFails, FakeBackend()).ship(request) { #expect(step == .commit && message.contains("no identity")) }
        else { Issue.record("commit-tree") }
        #expect(commitFails.pushes.isEmpty)

        let pushFails = happyGit(); pushFails.pushError = Boom(text: "network down"); let none = FakeBackend()
        if case .failed(let step, let message) = await shipper(pushFails, none).ship(request) { #expect(step == .push && message.contains("network down") && message.contains("untouched")) }
        else { Issue.record("push") }
        #expect(none.created.isEmpty)

        let backend = FakeBackend(); backend.createError = Boom(text: "403")
        let mrFails = happyGit()
        if case .failed(let step, let message) = await shipper(mrFails, backend).ship(request) { #expect(step == .mergeRequest && message.contains("is pushed") && message.contains("untouched")) }
        else { Issue.record("mr") }
        #expect(mrFails.pushes.count == 1)
    }

    @Test("an earlier request that is still open does not stop the next one")
    func eachShipmentIsItsOwn() async {
        let backend = FakeBackend()
        backend.open = [RepoMergeRequest(id: "5", number: 5, title: "t", state: "opened",
                                         sourceBranch: "loop/regression-20261001-000000", targetBranch: "main",
                                         webUrl: "https://gitlab.example/5", isDraft: false)]
        guard case .shipped(let branch, _, _) = await shipper(happyGit(), backend).ship(request) else { Issue.record("blocked"); return }
        #expect(branch != "loop/regression-20261001-000000" && backend.created.count == 1)
    }

    @Test("nothing to ship is a skip, not a request")
    func empty() async {
        var none = request; none.paths = []
        if case .skipped = await shipper(happyGit(), FakeBackend()).ship(none) {} else { Issue.record("no paths") }
    }

    @Test("planning: status -z entries (renames, unicode, spaces), secrets, remotes, branch names")
    func planning() {
        let raw = " M a.py\0?? 日本語 file.txt\0R  new name.py\0old name.py\0?? \"quoted\".py\0"
        let entries = ShipPlanning.statusEntries(porcelainZ: raw)
        #expect(entries.map(\.path) == ["a.py", "日本語 file.txt", "new name.py", "\"quoted\".py"], "no quoting or escaping with -z")
        #expect(entries[2].originalPath == "old name.py" && entries[2].allPaths == ["new name.py", "old name.py"])
        #expect(entries[1].isUntracked && !entries[0].isUntracked)

        for secret in [".env", "app/.env.local", "keys/server.pem", "id_rsa", "cfg/credentials.json", ".aws/config", "a/.ssh/known_hosts", "x.p12", "service-account-prod.json"] {
            #expect(ShipPlanning.isSecretPath(secret), "\(secret) is a secret")
        }
        for fine in [".env.example", "src/env.py", "README.md", "docs/key-concepts.md", "src/keyboard.py", ".github/workflows/ci.yml"] {
            #expect(!ShipPlanning.isSecretPath(fine), "\(fine) is not a secret")
        }
        #expect(ShipPlanning.sameRemote(saved: "owner/name", origin: "git@github.com:Owner/Name.git"), "a bare owner/name matches on the path")
        #expect(!ShipPlanning.sameRemote(saved: "https://gitlab.example/g/p", origin: "https://other.example/g/p"))
        #expect(!ShipPlanning.sameRemote(saved: "https://gitlab.example/g/p", origin: "https://gitlab.example/g/p-fork"))
        #expect(ShipPlanning.branchPrefix(for: "Regression") == "loop/regression")
        #expect(ShipPlanning.branchPrefix(for: "日本語") == "loop/run")
        #expect(ShipPlanning.branchName(prefix: "loop/x", at: Date(timeIntervalSince1970: 0)) == "loop/x-19700101-000000")
        #expect(ShipPlanning.defaultBranch(fromSymbolicRef: "refs/remotes/origin/develop\n") == "develop")
    }
}
