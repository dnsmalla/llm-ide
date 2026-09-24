import XCTest
@testable import LlmIdeMacLib

/// Stop / Quit must end an auto-task CLI even when it ignores SIGTERM —
/// otherwise `runCLI`'s continuation never resumes and `isRunning` sticks.
final class AutoCodeUpdateServiceCancelTests: XCTestCase {
    /// A shell that traps (ignores) SIGTERM and would otherwise sleep 30 s.
    private func startSigtermIgnoringProcess() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "trap '' TERM; sleep 30 & wait; sleep 30"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        // Let the trap install before signalling.
        usleep(200_000)
        return p
    }

    func testKillFallbackEndsProcessThatIgnoresSigterm() throws {
        let p = try startSigtermIgnoringProcess()
        let exited = expectation(description: "process exited")
        p.terminationHandler = { _ in exited.fulfill() }
        AutoCodeUpdateService.terminateWithKillFallback(p, grace: 0.3)
        wait(for: [exited], timeout: 5)
        XCTAssertFalse(p.isRunning)
        XCTAssertEqual(p.terminationReason, .uncaughtSignal)
        XCTAssertEqual(p.terminationStatus, SIGKILL)
    }

    func testBlockingTerminateEndsProcessThatIgnoresSigterm() throws {
        let p = try startSigtermIgnoringProcess()
        let exited = expectation(description: "process exited")
        p.terminationHandler = { _ in exited.fulfill() }
        AutoCodeUpdateService.terminateBlocking(p, grace: 0.3)
        wait(for: [exited], timeout: 5)
        XCTAssertFalse(p.isRunning)
    }

    func testKillFallbackIsNoOpForFinishedProcess() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try p.run()
        p.waitUntilExit()
        // Must not crash or signal anything.
        AutoCodeUpdateService.terminateWithKillFallback(p, grace: 0.1)
        AutoCodeUpdateService.terminateBlocking(p, grace: 0.1)
        XCTAssertEqual(p.terminationStatus, 0)
    }
}
