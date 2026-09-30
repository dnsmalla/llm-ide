import Darwin
import XCTest
@testable import LlmIdeMacLib

/// The Loop's subprocess primitive: group kill, bounded capture, total decode.
/// Every test that starts a long `sleep` kills it again in `tearDown`, so a
/// failing assertion cannot leave stray processes behind.
final class GroupedSubprocessTests: XCTestCase {
    private var strays: Set<pid_t> = []
    private let tmp = FileManager.default.temporaryDirectory

    override func tearDown() {
        for pid in strays { kill(pid, SIGKILL) }
        strays = []
        super.tearDown()
    }

    private func isAlive(_ pid: pid_t) -> Bool {
        ProcessTree.startTime(of: pid) != nil
    }

    /// Polls up to `seconds` for every pid to be gone.
    private func waitAllDead(_ pids: [pid_t], seconds: TimeInterval = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if pids.allSatisfy({ !isAlive($0) }) { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return pids.allSatisfy { !isAlive($0) }
    }

    private func pids(in output: String, tag: String) -> [pid_t] {
        output.split(separator: "\n").compactMap { line in
            line.hasPrefix(tag) ? pid_t(line.dropFirst(tag.count)) : nil
        }
    }

    // MARK: - Capture

    func testBackgroundedGrandchildHoldingThePipeDoesNotEmptyTheOutput() async throws {
        let started = Date()
        let outcome = try await ShellFaultVerifier().verify(
            command: "echo before; sleep 100 & echo \"pid:$!\"; echo after",
            repoRoot: tmp, timeout: 0)
        let held = pids(in: outcome.output, tag: "pid:")
        strays.formUnion(held)
        XCTAssertEqual(outcome.exitCode, 0)
        XCTAssertTrue(outcome.output.contains("before"), outcome.output)
        XCTAssertTrue(outcome.output.contains("after"), outcome.output)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "a held pipe must not stall the result")
        XCTAssertEqual(held.count, 1)
        let dead = await waitAllDead(held)
        XCTAssertTrue(dead, "the leftover holding the pipe is stopped")
    }

    func testNonUTF8ByteDoesNotEmptyTheOutput() async throws {
        let outcome = try await ShellFaultVerifier().verify(
            command: "printf 'ok\\377end\\n'; exit 3", repoRoot: tmp, timeout: 0)
        XCTAssertEqual(outcome.exitCode, 3)
        XCTAssertTrue(outcome.output.contains("ok"), outcome.output)
        XCTAssertTrue(outcome.output.contains("end"), outcome.output)
    }

    func testCappedBufferKeepsHeadAndTailWithAnElisionMarker() {
        let buffer = CappedOutputBuffer(headLimit: 8, tailLimit: 8)
        buffer.append(Data("HEADHEAD".utf8))
        for _ in 0..<100 { buffer.append(Data("middle-".utf8)) }
        buffer.append(Data("TAILTAIL".utf8))
        let text = buffer.text()
        XCTAssertTrue(text.hasPrefix("HEADHEAD"), text)
        XCTAssertTrue(text.hasSuffix("TAILTAIL"), text)
        XCTAssertTrue(text.contains("bytes of output elided"), text)
        XCTAssertTrue(buffer.wasElided)
        XCTAssertEqual(buffer.totalBytes, 16 + 700)
    }

    func testCappedBufferUnderTheLimitIsVerbatim() {
        let buffer = CappedOutputBuffer(headLimit: 4, tailLimit: 64)
        // "é" straddles the head/tail boundary (bytes 4 and 5).
        buffer.append(Data("abcé tail".utf8))
        XCTAssertEqual(buffer.text(), "abcé tail")
        XCTAssertFalse(buffer.wasElided)
    }

    // MARK: - Group kill

    func testTerminateTreeKillsEveryProcessInTheGroup() async throws {
        let proc = try GroupedSubprocess.launch(
            shellCommand: "sh -c 'sleep 100 & sleep 100'", directory: tmp)
        strays.insert(proc.pid)
        // Wait for the inner shell and both sleeps to exist.
        var tree: Set<pid_t> = []
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            tree = ProcessTree.descendants(of: proc.pid)
            if tree.count >= 2 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        strays.formUnion(tree)
        XCTAssertGreaterThanOrEqual(tree.count, 2, "expected the inner shell/sleeps under the outer shell")
        XCTAssertEqual(getpgid(proc.pid), proc.pid, "the child leads its own process group")

        proc.terminateTree(grace: 0.5)
        try await proc.waitForExit()
        let dead = await waitAllDead(Array(tree) + [proc.pid])
        XCTAssertTrue(dead, "SIGTERM/SIGKILL to the group reaches every member")
        XCTAssertNotEqual(proc.exitStatus, 0)
    }

    func testVerifierTimeoutStopsTheWholeTree() async throws {
        let marker = tmp.appendingPathComponent("grouped-\(UUID().uuidString).pids")
        defer { try? FileManager.default.removeItem(at: marker) }
        let started = Date()
        do {
            _ = try await ShellFaultVerifier().verify(
                command: "sleep 100 & echo $! >> '\(marker.path)'; sleep 100 & echo $! >> '\(marker.path)'; wait",
                repoRoot: tmp, timeout: 1)
            XCTFail("expected a timeout")
        } catch VerifyError.timedOut {}
        let written = (try? String(contentsOf: marker, encoding: .utf8)) ?? ""
        let sleeps = written.split(separator: "\n").compactMap { pid_t($0) }
        strays.formUnion(sleeps)
        XCTAssertEqual(sleeps.count, 2)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
        let dead = await waitAllDead(sleeps)
        XCTAssertTrue(dead, "a timeout kills the grandchildren, not just /bin/sh")
    }
}
