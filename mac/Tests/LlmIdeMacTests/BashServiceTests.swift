import XCTest
@testable import LlmIdeMacLib

/// BashService runs the shell commands the Code Assistant proposes, and every
/// test here pins a failure mode that previously killed a whole chat turn:
///
///  - Output larger than a pipe buffer (~64 KB) DEADLOCKED: the old
///    implementation called `waitUntilExit()` before reading, so the child
///    blocked writing while the app blocked waiting — on `@MainActor`, which
///    froze the UI with the pending-action card still on screen and no result
///    ever returned. `testLargeOutputDoesNotDeadlock` is that regression; a
///    reintroduction hangs the test rather than failing it, which is why every
///    case runs under an explicit XCTest timeout.
///  - No wall-clock timeout: a runaway command hung the turn forever.
///  - No output cap: a repo-wide `grep` was appended to the chat verbatim,
///    evicting the rest of the conversation from the model's context.
final class BashServiceTests: XCTestCase {

    private let service = BashService()

    func testCapturesStdoutAndExitCode() async {
        let r = await service.execute("echo hello")
        XCTAssertEqual(r.exitCode, 0)
        XCTAssertTrue(r.isSuccess)
        XCTAssertEqual(r.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "hello")
        XCTAssertFalse(r.timedOut)
        XCTAssertFalse(r.truncated)
    }

    func testCapturesStderrAndNonZeroExit() async {
        let r = await service.execute("echo oops 1>&2; exit 3")
        XCTAssertEqual(r.exitCode, 3)
        XCTAssertFalse(r.isSuccess)
        XCTAssertTrue(r.stderr.contains("oops"))
        // A lone stderr renders unlabelled — the caller already prefixes the
        // exit code, so a "STDERR:" header just adds noise.
        XCTAssertFalse(r.output.contains("STDOUT:"))
    }

    func testLabelsBothStreamsWhenBothArePresent() async {
        let r = await service.execute("echo out; echo err 1>&2")
        XCTAssertTrue(r.output.contains("STDOUT:"))
        XCTAssertTrue(r.output.contains("STDERR:"))
    }

    /// THE regression: far more than one pipe buffer of output must come back.
    func testLargeOutputDoesNotDeadlock() async {
        // ~600 KB, an order of magnitude past the ~64 KB pipe capacity, and
        // past the 1 MB retention cap only in aggregate with stderr below.
        let r = await service.execute("yes 0123456789 | head -n 60000")
        XCTAssertEqual(r.exitCode, 0)
        XCTAssertFalse(r.stdout.isEmpty)
        // Capped for the chat, but the command still completed rather than hanging.
        XCTAssertLessThanOrEqual(r.stdout.count, BashService.maxOutputChars)
        XCTAssertTrue(r.truncated, "a 600 KB result must report itself truncated")
        XCTAssertTrue(r.output.contains("(output truncated)"))
    }

    /// Both streams oversized at once — each is drained on its own thread, so
    /// neither can block the other.
    func testLargeOutputOnBothStreamsDoesNotDeadlock() async {
        let r = await service.execute(
            "yes aaaaaaaaaa | head -n 20000; yes bbbbbbbbbb | head -n 20000 1>&2")
        XCTAssertEqual(r.exitCode, 0)
        XCTAssertFalse(r.stdout.isEmpty)
        XCTAssertFalse(r.stderr.isEmpty)
    }

    func testTimeoutKillsTheCommand() async {
        let started = Date()
        let r = await service.execute("sleep 30", timeout: 1)
        XCTAssertTrue(r.timedOut)
        XCTAssertFalse(r.isSuccess)
        XCTAssertLessThan(Date().timeIntervalSince(started), 15,
                          "must return promptly after the timeout, not wait out the sleep")
        XCTAssertTrue(r.output.contains("timed out"))
    }

    /// A child that ignores SIGTERM still dies, and its output is still
    /// collected rather than left waiting on EOF.
    func testTimeoutEscalatesToKillForAnUnkillableChild() async {
        let r = await service.execute("trap '' TERM; sleep 30", timeout: 1)
        XCTAssertTrue(r.timedOut)
    }

    func testRunsInTheGivenWorkingDirectory() async {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("bash-service-cwd-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let r = await service.execute("pwd", workingDirectory: tmp.path)
        // /var vs /private/var: compare resolved paths.
        XCTAssertEqual(
            URL(fileURLWithPath: r.stdout.trimmingCharacters(in: .whitespacesAndNewlines))
                .resolvingSymlinksInPath().path,
            tmp.resolvingSymlinksInPath().path)
    }

    /// stdin is detached, so a command that reads input fails fast on EOF
    /// instead of blocking until the timeout.
    func testStdinIsDetachedSoAPromptingCommandDoesNotHang() async {
        let started = Date()
        let r = await service.execute("read line; echo \"got:$line\"", timeout: 10)
        XCTAssertFalse(r.timedOut, "should hit EOF immediately, not the timeout")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    func testLaunchFailureIsReportedNotThrown() async {
        let r = await service.execute("true", workingDirectory: "/no/such/directory//x")
        XCTAssertEqual(r.exitCode, -1)
        XCTAssertFalse(r.stderr.isEmpty)
        XCTAssertFalse(r.isSuccess)
    }

    func testCancellationTerminatesTheCommand() async {
        let task = Task { await service.execute("sleep 30", timeout: 60) }
        // Give the child a moment to launch so cancellation lands on a live
        // process rather than the pre-adopt window.
        try? await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        let started = Date()
        let r = await task.value
        XCTAssertFalse(r.isSuccess)
        XCTAssertLessThan(Date().timeIntervalSince(started), 15,
                          "cancel must kill the child, not wait out the sleep")
    }

    func testValidateCommandBlocksObviouslyDestructiveCommands() {
        XCTAssertFalse(service.validateCommand("rm -rf /"))
        XCTAssertFalse(service.validateCommand("sudo mkfs /dev/disk2"))
        XCTAssertTrue(service.validateCommand("npm test"))
        XCTAssertTrue(service.validateCommand("rm -rf ./build"))
    }
}
