import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct RegressionRunnerTests {
    /// Tiny stand-in for LlmIdeAPIClient so the runner can be
    /// tested without hitting the network. Keyed by prompt → reply.
    final class FakePrompter: RegressionPrompter {
        var replies: [String: String] = [:]
        var calls: [String] = []
        func ask(prompt: String) async throws -> String {
            calls.append(prompt)
            return replies[prompt] ?? ""
        }
    }

    private func tmpRepo() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("regression-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeFault(_ store: MemoryStore, at repo: URL,
                         prompt: String, response: String, status: FaultStatus) throws -> URL {
        let fault = FaultReport(
            prompt: prompt, response: response, notes: "",
            severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1", agent: "claude_code",
            status: status, tags: []
        )
        return try store.writeFault(at: repo, fault)
    }

    @Test func unchangedWhenAnswerMatchesAfterWhitespaceNormalisation() {
        let v = RegressionRunner.verdict(
            originalAnswer: "Auth uses JWT.\nRefresh with the /refresh endpoint.",
            currentAnswer: "Auth   uses JWT.  Refresh with the /refresh endpoint.  "
        )
        #expect(v == .unchanged)
    }

    @Test func regressedWhenAnswerDiffers() {
        let v = RegressionRunner.verdict(
            originalAnswer: "JWT with refresh",
            currentAnswer: "Cookies with sessions"
        )
        #expect(v == .regressed)
    }

    @Test func runIteratesOnlyFixedFaultsAndPopulatesResults() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()

        _ = try writeFault(store, at: repo, prompt: "fixed-q",
                         response: "fixed-answer", status: .fixed)
        _ = try writeFault(store, at: repo, prompt: "open-q",
                         response: "open-answer", status: .open)
        _ = try writeFault(store, at: repo, prompt: "wontfix-q",
                         response: "wf-answer", status: .wontFix)

        let prompter = FakePrompter()
        prompter.replies["fixed-q"] = "fixed-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(prompter.calls == ["fixed-q"])
        #expect(runner.results.count == 1)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func regressedFaultIsAutoReopenedWhenOptedIn() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q",
                               response: "original-answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["q"] = "drifted-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo, autoReopen: true)

        #expect(runner.results.first?.verdict == .regressed)
        #expect(runner.results.first?.autoReopened == true)
        // The frontmatter on disk is now `status: open`.
        let reloaded = try store.loadFault(at: url)
        #expect(reloaded.status == .open)
    }

    @Test func regressedFaultIsNotMutatedByDefault() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q",
                               response: "original-answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["q"] = "drifted-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)   // autoReopen defaults to false

        // Drift is still reported…
        #expect(runner.results.first?.verdict == .regressed)
        // …but the file is NOT touched.
        #expect(runner.results.first?.autoReopened == false)
        let reloaded = try store.loadFault(at: url)
        #expect(reloaded.status == .fixed)
    }

    @Test func unchangedFaultStaysFixed() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q",
                               response: "the-answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["q"] = "the-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(runner.results.first?.autoReopened == false)
        let reloaded = try store.loadFault(at: url)
        #expect(reloaded.status == .fixed)
    }

    @Test func runWithOnlyFilterAsksOnlySelectedFaults() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let urlA = try writeFault(store, at: repo, prompt: "a",
                                response: "a-answer", status: .fixed)
        _ = try writeFault(store, at: repo, prompt: "b",
                         response: "b-answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["a"] = "a-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo, only: [urlA])

        #expect(prompter.calls == ["a"])
        #expect(runner.results.count == 1)
        #expect(runner.results.first?.prompt == "a")
    }

    @Test func runStreamsLogAndEndsWithCompleteLine() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "x",
                         response: "answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["x"] = "answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(!runner.log.isEmpty)
        #expect(runner.log.first?.text.hasPrefix("Run started") == true)
        #expect(runner.log.last?.text.hasPrefix("Run complete") == true)
    }

    @Test func runMarksRegressedWhenAgentDriftsAndFailedOnError() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "drifted-q",
                         response: "old-answer", status: .fixed)

        final class ThrowingPrompter: RegressionPrompter {
            func ask(prompt: String) async throws -> String {
                throw NSError(domain: "test", code: 1, userInfo: nil)
            }
        }
        let runner = RegressionRunner(prompter: ThrowingPrompter(), store: store)
        await runner.run(at: repo)

        #expect(runner.results.count == 1)
        if case .failed = runner.results.first?.verdict {
            // ok
        } else {
            Issue.record("expected .failed verdict, got \(String(describing: runner.results.first?.verdict))")
        }
    }
}

// MARK: - Semantic judge

@MainActor
struct RegressionJudgeTests {
    final class FakePrompter: RegressionPrompter {
        var replies: [String: String] = [:]
        func ask(prompt: String) async throws -> String { replies[prompt] ?? "" }
    }

    /// Scripted judge: returns the canned equivalence verdict, or
    /// throws when `error` is set.
    final class FakeJudge: RegressionJudge {
        var equivalent: Bool
        var error: Error?
        var calls = 0
        init(equivalent: Bool, error: Error? = nil) {
            self.equivalent = equivalent
            self.error = error
        }
        func sameMeaning(prompt: String, original: String, current: String) async throws -> Bool {
            calls += 1
            if let error { throw error }
            return equivalent
        }
    }

    private func tmpRepo() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("regression-judge-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeFixedFault(_ store: MemoryStore, at repo: URL,
                                 prompt: String, response: String) throws -> URL {
        let fault = FaultReport(
            prompt: prompt, response: response, notes: "",
            severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1", agent: "claude_code",
            status: .fixed, tags: []
        )
        return try store.writeFault(at: repo, fault)
    }

    @Test func rewordedAnswerStaysUnchangedWhenJudgeSaysEquivalent() async throws {
        let repo = try tmpRepo()
        let store = MemoryStore()
        let url = try writeFixedFault(store, at: repo,
                                      prompt: "How does auth work?",
                                      response: "Auth uses JWT tokens.")
        let prompter = FakePrompter()
        prompter.replies["How does auth work?"] = "Authentication is JWT-based."
        let judge = FakeJudge(equivalent: true)
        let runner = RegressionRunner(prompter: prompter, judge: judge, store: store)

        await runner.run(at: repo)

        #expect(judge.calls == 1)
        #expect(runner.results.first?.verdict == .unchanged)
        #expect(runner.results.first?.autoReopened == false)
        let onDisk = try store.loadFault(at: url)
        #expect(onDisk.status == .fixed)
    }

    @Test func judgeConfirmedRegressionStillAutoReopens() async throws {
        let repo = try tmpRepo()
        let store = MemoryStore()
        let url = try writeFixedFault(store, at: repo,
                                      prompt: "How does auth work?",
                                      response: "Auth uses JWT tokens.")
        let prompter = FakePrompter()
        prompter.replies["How does auth work?"] = "Auth uses plain session cookies."
        let judge = FakeJudge(equivalent: false)
        let runner = RegressionRunner(prompter: prompter, judge: judge, store: store)

        // This test asserts auto-reopen, so it must enable it (the parameter
        // defaults to false — see runDefaultsToNoAutoReopen).
        await runner.run(at: repo, autoReopen: true)

        #expect(runner.results.first?.verdict == .regressed)
        #expect(runner.results.first?.autoReopened == true)
        let onDisk = try store.loadFault(at: url)
        #expect(onDisk.status == .open)
    }

    @Test func judgeFailureLeavesVerdictFailedAndFaultFixed() async throws {
        let repo = try tmpRepo()
        let store = MemoryStore()
        let url = try writeFixedFault(store, at: repo,
                                      prompt: "How does auth work?",
                                      response: "Auth uses JWT tokens.")
        let prompter = FakePrompter()
        prompter.replies["How does auth work?"] = "Different wording."
        let judge = FakeJudge(equivalent: false,
                              error: NSError(domain: "test", code: 1,
                                             userInfo: [NSLocalizedDescriptionKey: "offline"]))
        let runner = RegressionRunner(prompter: prompter, judge: judge, store: store)

        await runner.run(at: repo)

        guard case .failed = runner.results.first?.verdict else {
            Issue.record("expected .failed, got \(String(describing: runner.results.first?.verdict))")
            return
        }
        #expect(runner.results.first?.autoReopened == false)
        let onDisk = try store.loadFault(at: url)
        #expect(onDisk.status == .fixed)
    }

    @Test func exactMatchSkipsTheJudgeEntirely() async throws {
        let repo = try tmpRepo()
        let store = MemoryStore()
        _ = try writeFixedFault(store, at: repo,
                                prompt: "How does auth work?",
                                response: "Auth uses JWT tokens.")
        let prompter = FakePrompter()
        prompter.replies["How does auth work?"] = "Auth   uses JWT tokens.\n"
        let judge = FakeJudge(equivalent: false) // would regress if consulted
        let runner = RegressionRunner(prompter: prompter, judge: judge, store: store)

        await runner.run(at: repo)

        #expect(judge.calls == 0)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func judgeReplyParsing() throws {
        #expect(try CodeAssistJudge.parseReply("YES") == true)
        #expect(try CodeAssistJudge.parseReply("  yes — same facts.") == true)
        #expect(try CodeAssistJudge.parseReply("No.") == false)
        #expect(try CodeAssistJudge.parseReply("NO, B contradicts A.") == false)
        #expect(throws: CodeAssistJudge.JudgeError.self) {
            _ = try CodeAssistJudge.parseReply("The answers are mostly similar.")
        }
    }
}
