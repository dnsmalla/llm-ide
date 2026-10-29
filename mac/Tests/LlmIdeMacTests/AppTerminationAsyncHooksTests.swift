import Foundation
import Testing
@testable import LlmIdeMacLib

/// T4.1 (live-then-archive): async quit hooks under `.terminateLater`.
/// Fake hooks only; no NSApplication is involved (the decision and the runner are pure).
@MainActor
@Suite("Async termination hooks (T4.1)")
struct AppTerminationAsyncHooksTests {

    private final class Log: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    }
    private struct Boom: Error {}

    private func hook(_ label: String, timeout: TimeInterval = 5, _ run: @escaping @MainActor () async throws -> Void)
        -> AppTerminationHooks.AsyncHook {
        .init(label: label, timeout: timeout, run: run)
    }

    @Test func successRunsEveryHookInOrder() async {
        let log = Log()
        let report = await AppTerminationHooks.runAsync([
            hook("a") { log.add("a") },
            hook("b") { log.add("b") },
        ], cap: 2)
        #expect(log.all == ["a", "b"])
        #expect(report.results.map(\.outcome) == [.completed, .completed])
        #expect(!report.capReached)
    }

    @Test func aThrowingHookIsLoggedAndTheNextStillRuns() async {
        let log = Log()
        let report = await AppTerminationHooks.runAsync([
            hook("bad") { throw Boom() },
            hook("good") { log.add("good") },
        ], cap: 2)
        #expect(log.all == ["good"])
        if case .failed = report.results[0].outcome {} else { Issue.record("expected failed") }
        #expect(report.results[1].outcome == .completed)
    }

    @Test func aHookThatNeverAnswersIsAbandonedAtItsTimeout() async {
        let log = Log()
        let started = Date()
        let report = await AppTerminationHooks.runAsync([
            hook("stuck", timeout: 0.2) { try await Task.sleep(for: .seconds(30)) },
            hook("after") { log.add("after") },
        ], cap: 3)
        #expect(Date().timeIntervalSince(started) < 2, "the stuck hook must not hold the quit")
        #expect(report.results[0].outcome == .timedOut)
        #expect(log.all == ["after"], "a timeout does not stop later hooks")
    }

    @Test func theHardCapBoundsTheWholePhaseAndNamesWhatNeverStarted() async {
        let log = Log()
        let started = Date()
        let report = await AppTerminationHooks.runAsync([
            hook("slow", timeout: 30) { try await Task.sleep(for: .seconds(30)) },
            hook("never") { log.add("never") },
        ], cap: 0.3)
        let elapsed = Date().timeIntervalSince(started)
        #expect(elapsed < 2, "cap respected: \(elapsed)s")
        #expect(report.capReached)
        #expect(report.notStarted == ["never"])
        #expect(log.all.isEmpty)
    }

    @Test func noHooksIsANoOpReport() async {
        let report = await AppTerminationHooks.runAsync([], cap: 1)
        #expect(report.results.isEmpty && !report.capReached)
    }

    @Test func registrationFeedsTheRunner() async {
        AppTerminationHooks.resetForTesting()
        defer { AppTerminationHooks.resetForTesting() }
        #expect(!AppTerminationHooks.hasAsyncHooks)
        let log = Log()
        AppTerminationHooks.registerAsync("x", timeout: 1) { log.add("x") }
        #expect(AppTerminationHooks.hasAsyncHooks)
        let report = await AppTerminationHooks.runAsyncHooks(cap: 1)
        #expect(log.all == ["x"] && report.results.count == 1)
    }

    // MARK: the decision (drafts dialog first)

    @Test func theDraftsConfirmationComesFirstAndACancelRunsNothing() {
        var asked = 0
        let d = AppTerminationDecision.decide(confirmDrafts: { asked += 1; return false }, hasAsyncHooks: true, inFlight: false)
        #expect(d == .cancel && asked == 1)
    }

    @Test func withoutAsyncHooksTheQuitIsTheSynchronousOneItAlwaysWas() {
        let d = AppTerminationDecision.decide(confirmDrafts: { true }, hasAsyncHooks: false, inFlight: false)
        #expect(d == .now)
    }

    @Test func aConfirmedQuitWithAsyncHooksIsHeldOpenOnce() {
        #expect(AppTerminationDecision.decide(confirmDrafts: { true }, hasAsyncHooks: true, inFlight: false) == .later(start: true))
        var asked = 0
        let second = AppTerminationDecision.decide(confirmDrafts: { asked += 1; return true }, hasAsyncHooks: true, inFlight: true)
        #expect(second == .later(start: false) && asked == 0, "a second quit request neither re-asks nor starts a second run")
    }
}
