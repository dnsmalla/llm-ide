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

    // Regression (2026-09 chat review): Stop SIGTERMed only the shell. A
    // grandchild (`npm test` → node) kept running and holding the pipes, so
    // the drains waited on EOF until it finished on its own. Here zsh can't
    // `exec` away its child (commands follow), and the inner `sh` does the same
    // to its `sleep`, so the sleep is a real grandchild holding stdout.
    func testCancellationKillsGrandchildrenHoldingThePipe() async {
        let task = Task {
            await service.execute("sh -c 'sleep 30; true'; true", timeout: 60)
        }
        try? await Task.sleep(nanoseconds: 500_000_000)
        task.cancel()
        let started = Date()
        let r = await task.value
        XCTAssertFalse(r.isSuccess)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10,
                          "cancel must tear down the whole tree, not wait out the grandchild")
    }

    func testProcessTreeFindsGrandchildren() async throws {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", "sh -c 'sleep 20; true'; true"]
        try shell.run()
        defer {
            for pid in ProcessTree.descendants(of: shell.processIdentifier) { kill(pid, SIGKILL) }
            shell.terminate()
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        // The inner sh and its sleep.
        XCTAssertGreaterThanOrEqual(ProcessTree.descendants(of: shell.processIdentifier).count, 2)
    }

    /// A kill that lands after the grace period re-checks each pid's start
    /// time: a recycled pid (same number, different process) is skipped.
    func testProcessTreeSignalSkipsARecycledPid() throws {
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
        sleeper.arguments = ["20"]
        try sleeper.run()
        defer { if sleeper.isRunning { kill(sleeper.processIdentifier, SIGKILL) } }
        let pid = sleeper.processIdentifier
        let start = try XCTUnwrap(ProcessTree.startTime(of: pid))

        ProcessTree.signal([pid: start &+ 1], SIGKILL)   // "a different process"
        usleep(100_000)
        XCTAssertTrue(sleeper.isRunning, "a pid whose start time changed must not be signalled")

        ProcessTree.signal([pid: start], SIGKILL)
        sleeper.waitUntilExit()
        XCTAssertFalse(sleeper.isRunning)
        XCTAssertNil(ProcessTree.startTime(of: pid), "a reaped pid has no start time")
    }

    func testValidateCommandBlocksObviouslyDestructiveCommands() {
        XCTAssertFalse(service.validateCommand("rm -rf /"))
        XCTAssertFalse(service.validateCommand("sudo mkfs /dev/disk2"))
        XCTAssertTrue(service.validateCommand("npm test"))
        XCTAssertTrue(service.validateCommand("rm -rf ./build"))
    }

    /// The old check was `lowercased().contains("rm -rf /")`, so every spelling
    /// below walked straight past it.
    func testValidateCommandBlocksRootDeletionWhateverItsSpelling() {
        for command in ["rm  -rf  /",                    // collapsed whitespace
                        "rm -fr /",                      // flag order
                        "rm -r -f /",                    // split flags
                        "rm --recursive --force /",      // long flags
                        "rm -rf --no-preserve-root /",
                        "sudo rm -rf /*",
                        "\\rm -rf /",                    // alias bypass
                        "cd /tmp && rm -rf /",           // second segment
                        "rm -rf ~",
                        "rm -rf $HOME"] {
            XCTAssertFalse(service.validateCommand(command), "should be blocked: \(command)")
        }
    }

    /// The old `"format"` substring refused these — `make format` is one of
    /// this repo's own documented commands, and `--pretty=format:` appears
    /// throughout its git plumbing.
    func testValidateCommandAllowsOrdinaryCommandsContainingScaryWords() {
        for command in ["make format",
                        "npm run format",
                        "swift-format --in-place Sources/",
                        "git log --pretty=format:%h",
                        "rm -rf ./build",
                        "rm -rf node_modules",
                        "rm -f /tmp/scratch.txt",        // force, but not recursive
                        "rm -r ./dist"] {                // recursive, but not force
            XCTAssertTrue(service.validateCommand(command), "should be allowed: \(command)")
        }
    }

    func testValidateCommandBlocksForkBombWhateverItsSpacing() {
        XCTAssertFalse(service.validateCommand(":(){ :|:& };:"))
        XCTAssertFalse(service.validateCommand(":(){:|:&};:"))
    }
}
