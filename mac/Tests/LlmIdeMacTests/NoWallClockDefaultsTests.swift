import XCTest
@testable import LlmIdeMacLib

/// Pins the "no wall clock on work" contract at every place a deadline used to
/// live. These are one-line assertions on defaults, and they exist because the
/// failure mode is silent: someone re-adds a plausible-looking ceiling, and the
/// only symptom is a user losing a long build or a long agent run to a message
/// that blames the duration. A test naming the removed value is the cheapest way
/// to make that a deliberate decision instead of an accident.
final class NoWallClockDefaultsTests: XCTestCase {

    func testBashServiceHasNoDefaultTimeout() {
        // Was 180 s, which killed `swift build` / `npm test` runs mid-flight.
        XCTAssertEqual(BashService.defaultTimeout, 0)
    }

    func testAnExplicitBashTimeoutStillWorks() async {
        // Removing the default must not remove the capability.
        let r = await BashService().execute("sleep 30", timeout: 1)
        XCTAssertTrue(r.timedOut)
        XCTAssertNil(r.stoppedForResources,
                     "an explicit timeout is a timeout, not a resource stop")
    }

    func testALongCommandIsNotKilledByDefault() async {
        // The regression this whole change set is about: a command that takes
        // longer than the old ceiling must simply finish.
        let r = await BashService().execute("sleep 2; echo done")
        XCTAssertEqual(r.exitCode, 0)
        XCTAssertFalse(r.timedOut)
        XCTAssertNil(r.stoppedForResources)
        XCTAssertEqual(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "done")
    }

    func testResourceStopIsReportedAsSuchNotAsATimeout() {
        // The chat-facing rendering must never call a resource stop a timeout.
        let r = BashService.ExecutionResult(
            exitCode: -15, stdout: "partial", stderr: "", duration: 42,
            timedOut: false,
            stoppedForResources: "stopped to protect the system — critical memory pressure",
            truncated: false)
        XCTAssertFalse(r.isSuccess)
        XCTAssertTrue(r.output.contains("memory pressure"))
        XCTAssertFalse(r.output.contains("timed out"))
    }

    func testLoopEngineConfigHasNoDefaultTimeBudget() {
        // Was 3600, which gave up on a progressing run at the hour mark and
        // recorded `.wallClockExceeded`.
        let config = LoopEngineConfig(stages: [])
        XCTAssertNil(config.wallClockBudgetSeconds)
    }

    func testAConfigSavedWithoutTheBudgetKeyDecodesAsUnlimited() throws {
        // Back-compat: an older saved config omits the key. It used to inherit
        // the 3600 default; it must now mean "no limit" like everything else.
        let json = #"{"stages":[],"maxIterations":10,"consecutiveFailureStop":2}"#
        let config = try JSONDecoder().decode(LoopEngineConfig.self, from: Data(json.utf8))
        XCTAssertNil(config.wallClockBudgetSeconds)
        XCTAssertEqual(config.maxIterations, 10)
    }

    func testADeliberateBudgetSurvivesARoundTrip() throws {
        // A user who sets a budget in Settings → Loop must keep it.
        let original = LoopEngineConfig(stages: [], wallClockBudgetSeconds: 900)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(LoopEngineConfig.self, from: data)
        XCTAssertEqual(decoded.wallClockBudgetSeconds, 900)
    }

    func testUnlimitedSurvivesARoundTrip() throws {
        let original = LoopEngineConfig(stages: [], wallClockBudgetSeconds: nil)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(LoopEngineConfig.self, from: data)
        XCTAssertNil(decoded.wallClockBudgetSeconds)
    }

    func testBuiltInTemplatesShipNoStageTimeouts() {
        // `make lint` (was 120 s) and `make docs-check` (was 300 s) both
        // legitimately exceed those figures on a large repo, and a stage killed
        // by the clock was recorded as a stage FAILURE.
        for template in LoopTemplate.builtIns {
            for stage in template.config.stages {
                XCTAssertNil(stage.timeoutSeconds,
                             "template \(template.name) stage \(stage.name) ships a wall-clock timeout")
            }
            XCTAssertNil(template.config.wallClockBudgetSeconds,
                         "template \(template.name) ships a time budget")
        }
    }

    func testVerifierTreatsNonPositiveTimeoutAsUnlimited() async throws {
        // 0 must mean "no limit", not "expire immediately" — the inverse would
        // fail every stage instantly.
        let outcome = try await ShellFaultVerifier().verify(
            command: "sleep 1; echo ok",
            repoRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
            timeout: 0)
        XCTAssertEqual(outcome.exitCode, 0)
        XCTAssertTrue(outcome.output.contains("ok"))
    }

    func testGitEnvNumbersEveryConfigPairAndSuppressesPrompts() {
        // git reads exactly GIT_CONFIG_COUNT pairs. The old code hardcoded COUNT=1
        // inside the credential helper, so adding the stall guard would either
        // lose the guard or hide the credential header — a silent auth failure.
        let authed = RepoManager.gitEnv(token: "tok", backend: .github)
        XCTAssertEqual(authed["GIT_CONFIG_COUNT"], "3")
        let keys = (0..<3).compactMap { authed["GIT_CONFIG_KEY_\($0)"] }
        XCTAssertEqual(Set(keys), ["http.lowSpeedLimit", "http.lowSpeedTime", "http.extraHeader"])
        XCTAssertEqual(authed["GIT_TERMINAL_PROMPT"], "0")

        // Unauthenticated: still gets the stall guard AND prompt suppression —
        // that path used to get neither, so a private remote could hang forever.
        let anon = RepoManager.gitEnv(token: nil, backend: .gitlab)
        XCTAssertEqual(anon["GIT_CONFIG_COUNT"], "2")
        XCTAssertEqual(anon["GIT_TERMINAL_PROMPT"], "0")
        XCTAssertNil(anon.first { $0.value.contains("PRIVATE-TOKEN") }?.key,
                     "no credential header without a token")
    }

    func testGitStallGuardIsAStallDetectorNotADeadline() {
        // ~1 KB/s sustained for 5 min. The point is that a slow-but-progressing
        // transfer is never aborted, however long it takes.
        let env = RepoManager.gitEnv(token: nil, backend: .github)
        let pairs = (0..<2).compactMap { i -> (String, String)? in
            guard let k = env["GIT_CONFIG_KEY_\(i)"], let v = env["GIT_CONFIG_VALUE_\(i)"] else { return nil }
            return (k, v)
        }
        let byKey = Dictionary(uniqueKeysWithValues: pairs)
        XCTAssertEqual(byKey["http.lowSpeedLimit"], "1000")
        XCTAssertEqual(byKey["http.lowSpeedTime"], "300")
    }

    func testAuthConfigPairShapePerBackend() {
        let gitlab = RepoManager.authConfigPair(token: "t", backend: .gitlab)
        XCTAssertEqual(gitlab.0, "http.extraHeader")
        XCTAssertEqual(gitlab.1, "PRIVATE-TOKEN: t")
        let github = RepoManager.authConfigPair(token: "t", backend: .github)
        XCTAssertTrue(github.1.hasPrefix("Authorization: Basic "))
    }

    func testVerifierStillHonoursAnExplicitTimeout() async {
        do {
            _ = try await ShellFaultVerifier().verify(
                command: "sleep 30",
                repoRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
                timeout: 1)
            XCTFail("expected a timeout")
        } catch let error as VerifyError {
            guard case .timedOut = error else {
                return XCTFail("expected .timedOut, got \(error)")
            }
        } catch {
            XCTFail("expected VerifyError, got \(error)")
        }
    }

    /// Cancelling the calling `Task` (the Loop's Stop button, or the app
    /// quitting) must not just walk away from `verify()` — it must kill the
    /// shell command too, or a `swift test`/`npm test` a Loop stage started
    /// keeps running as an orphan with nothing left watching it.
    func testCancellationTerminatesTheChildProcessRatherThanLeavingItOrphaned() async {
        let marker = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-cancel-marker-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: marker) }

        let task = Task {
            try await ShellFaultVerifier().verify(
                command: "sleep 5; touch \(marker.path)",
                repoRoot: URL(fileURLWithPath: NSTemporaryDirectory()),
                timeout: 0)
        }
        // Let the shell actually launch `sleep` before cancelling.
        try? await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("expected cancellation to throw")
        } catch is CancellationError {
            // expected
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }

        // If the process were left running, `touch` would create this file
        // ~5s after it started. Checking well before that (and well after
        // cancellation) is what actually distinguishes "killed" from
        // "orphaned and still running".
        try? await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path),
                       "cancellation must terminate the child process, not just stop awaiting it")
    }
}
