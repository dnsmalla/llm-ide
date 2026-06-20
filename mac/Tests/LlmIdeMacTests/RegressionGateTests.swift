import Testing
import Foundation
@testable import LlmIdeMac

/// Tests the regression "upgrade gate": after a run, the faults registry
/// CSV is re-exported, so a regressed (auto-reopened) fault shows up as
/// `open` while an unchanged one stays `fixed`.
@MainActor
struct RegressionGateTests {
    final class FakePrompter: RegressionPrompter {
        var replies: [String: String] = [:]
        func ask(prompt: String) async throws -> String {
            replies[prompt] ?? ""
        }
    }

    private func tmpRepo() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("regression-gate-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func writeFault(_ store: MemoryStore, at repo: URL,
                            prompt: String, response: String,
                            status: FaultStatus, reportedAt: Date) throws -> URL {
        let fault = FaultReport(
            prompt: prompt, response: response, notes: "",
            severity: .major, reportedAt: reportedAt,
            gitHead: nil, appVersion: "0.1", agent: "claude_code",
            status: status, tags: []
        )
        return try store.writeFault(at: repo, fault)
    }

    /// Fake judge that always returns `false` (semantically different),
    /// so textually-drifted answers are confirmed as genuine regressions
    /// and auto-reopen is allowed to proceed.
    final class AlwaysRegressJudge: RegressionJudge {
        func sameMeaning(prompt: String, original: String, current: String) async throws -> Bool {
            return false   // never the same meaning → genuine regression → reopen
        }
    }

    @Test func exportedCSVReflectsRegressionAndUnchangedStatus() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()

        // Earlier reported_at sorts first by file name.
        let regressedURL = try writeFault(store, at: repo, prompt: "regress-q",
                                          response: "good-answer", status: .fixed,
                                          reportedAt: Date(timeIntervalSince1970: 1_716_465_600))
        _ = try writeFault(store, at: repo, prompt: "steady-q",
                           response: "steady-answer", status: .fixed,
                           reportedAt: Date(timeIntervalSince1970: 1_716_552_000))

        let prompter = FakePrompter()
        prompter.replies["regress-q"] = "drifted-answer"   // differs → regressed
        prompter.replies["steady-q"]  = "steady-answer"    // same → unchanged

        // A judge is required to allow auto-reopen. AlwaysRegressJudge confirms
        // every textual drift as a genuine regression so the fault is reopened.
        let runner = RegressionRunner(prompter: prompter, judge: AlwaysRegressJudge(), store: store)
        await runner.run(at: repo, autoReopen: true)

        // The run exported a fresh CSV.
        let csvURL = try #require(runner.lastCSVURL)
        let contents = try String(contentsOf: csvURL, encoding: .utf8)

        // The regressed fault was auto-reopened, so its row reads `open`.
        // The steady fault stays `fixed`.
        let lines = contents.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let regressRow = try #require(lines.first { $0.contains("regress-q") })
        let steadyRow = try #require(lines.first { $0.contains("steady-q") })
        #expect(regressRow.contains(",\"open\","))
        #expect(steadyRow.contains(",\"fixed\","))

        // And the on-disk fault file matches.
        let reloaded = try store.loadFault(at: regressedURL)
        #expect(reloaded.status == .open)
    }

    @Test func noJudgeWithAutoReopenDoesNotMutateDiskOnTextualDrift() async throws {
        let repo = try tmpRepo()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q",
                                 response: "the answer is 42", status: .fixed,
                                 reportedAt: Date(timeIntervalSince1970: 1_716_465_600))
        let prompter = FakePrompter()
        prompter.replies["q"] = "the answer is forty-two"   // textual drift, same meaning

        // No judge supplied + autoReopen requested → MUST refuse to reopen.
        let runner = RegressionRunner(prompter: prompter, judge: nil, store: store)
        await runner.run(at: repo, autoReopen: true)

        let reloaded = try store.loadFault(at: url)
        #expect(reloaded.status == .fixed)   // not flipped to .open
    }
}
