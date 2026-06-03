import Testing
import Foundation
@testable import MeetNotesMac

@MainActor
struct RegressionRunnerTests {
    /// Tiny stand-in for MeetNotesAPIClient so the runner can be
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

    private func writeBug(_ store: MemoryStore, at repo: URL,
                         prompt: String, response: String, status: BugStatus) throws -> URL {
        let bug = BugReport(
            prompt: prompt, response: response, notes: "",
            severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1", agent: "claude_code",
            status: status, tags: []
        )
        return try store.writeBug(at: repo, bug)
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

    @Test func runIteratesOnlyFixedBugsAndPopulatesResults() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()

        _ = try writeBug(store, at: repo, prompt: "fixed-q",
                         response: "fixed-answer", status: .fixed)
        _ = try writeBug(store, at: repo, prompt: "open-q",
                         response: "open-answer", status: .open)
        _ = try writeBug(store, at: repo, prompt: "wontfix-q",
                         response: "wf-answer", status: .wontFix)

        let prompter = FakePrompter()
        prompter.replies["fixed-q"] = "fixed-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(prompter.calls == ["fixed-q"])
        #expect(runner.results.count == 1)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func regressedBugIsAutoReopenedOnDisk() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeBug(store, at: repo, prompt: "q",
                               response: "original-answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["q"] = "drifted-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(runner.results.first?.verdict == .regressed)
        #expect(runner.results.first?.autoReopened == true)
        // The frontmatter on disk is now `status: open`.
        let reloaded = try store.loadBug(at: url)
        #expect(reloaded.status == .open)
    }

    @Test func unchangedBugStaysFixed() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeBug(store, at: repo, prompt: "q",
                               response: "the-answer", status: .fixed)
        let prompter = FakePrompter()
        prompter.replies["q"] = "the-answer"

        let runner = RegressionRunner(prompter: prompter, store: store)
        await runner.run(at: repo)

        #expect(runner.results.first?.autoReopened == false)
        let reloaded = try store.loadBug(at: url)
        #expect(reloaded.status == .fixed)
    }

    @Test func runWithOnlyFilterAsksOnlySelectedBugs() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let urlA = try writeBug(store, at: repo, prompt: "a",
                                response: "a-answer", status: .fixed)
        _ = try writeBug(store, at: repo, prompt: "b",
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
        _ = try writeBug(store, at: repo, prompt: "x",
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
        _ = try writeBug(store, at: repo, prompt: "drifted-q",
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
