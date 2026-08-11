// Runs a fault's verify command as a local subprocess. A non-zero exit
// means the fault is present (regression); exit 0 means fixed. The
// command string is the agent-authored, user-approved verify command —
// nothing else reaches /bin/sh, and no fault content is interpolated
// into the command line.

import Foundation

struct VerifyOutcome: Equatable {
    let exitCode: Int32
    let output: String   // combined stdout + stderr
}

enum VerifyError: Error, Equatable {
    case timedOut(TimeInterval)
    case launchFailed(String)
    /// The ResourceGuard terminated the command to protect the machine.
    ///
    /// Distinct from every other outcome on purpose. A guard SIGTERM makes the
    /// process exit non-zero, and a non-zero exit is how this type reports "the
    /// fault is present" — so without its own case, a resource stop was
    /// indistinguishable from a failing test. The callers respond to a failing
    /// test by asking an LLM to repair it, which means firing off more work at
    /// the exact moment the system is under critical memory pressure. Raising an
    /// error instead ends the run cleanly and truthfully.
    case stoppedForResources(String)
}

/// Without this, `.localizedDescription` on a `VerifyError` falls back to
/// NSError's generic "The operation couldn't be completed" text instead of
/// the actual diagnostic — every caller that logs `error.localizedDescription`
/// (this file's `ShellFaultVerifier`'s own launch-failure path used to hit
/// this indirectly via `Process`, and `LoopEngineRunner`/`RegressionRunner`
/// both catch and log `VerifyError` this way) would otherwise lose the
/// real reason silently.
extension VerifyError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .timedOut(let seconds): return "timed out after \(seconds)s"
        case .launchFailed(let reason): return "launch failed: \(reason)"
        case .stoppedForResources(let reason): return reason
        }
    }
}

protocol FaultVerifier: Sendable {
    func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome
}

struct ShellFaultVerifier: FaultVerifier {
    func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = repoRoot
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do { try process.run() } catch {
            throw VerifyError.launchFailed(error.localizedDescription)
        }

        // Read output on a background thread so a large stream can't
        // deadlock the pipe before the process exits.
        let dataBox = OutputBox()
        let reader = Thread {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            dataBox.set(data)
        }
        reader.start()

        // `timeout <= 0` means no limit, which is now the default everywhere that
        // calls this: a verification command is the user's own test suite or
        // build, and killing it at an arbitrary mark reports "timed out" for a
        // stage that was simply still working. The guard below still runs for a
        // caller that opted into a finite timeout.
        let deadline: Date? = timeout > 0 ? Date().addingTimeInterval(timeout) : nil
        // The machine, not the clock, is what stops an unbounded run. The reason
        // is recorded so the non-zero exit that follows the SIGTERM is reported as
        // a resource stop rather than as a failing test (see
        // VerifyError.stoppedForResources).
        let stopReason = ResourceStopBox()
        let guardToken = ResourceGuardService.shared.register(
            label: "verify: \(command.prefix(60))"
        ) { [weak process] reason in
            stopReason.set(reason)
            guard let p = process, p.isRunning else { return }
            p.terminate()
        }
        defer { guardToken.cancel() }
        while process.isRunning {
            if let deadline, Date() >= deadline {
                process.terminate()                       // SIGTERM
                // Grace period, then hard-kill if it ignored SIGTERM.
                let killBy = Date().addingTimeInterval(0.5)
                while process.isRunning && Date() < killBy {
                    try? await Task.sleep(nanoseconds: 25_000_000)
                }
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()                   // reap; closes pipe → reader unblocks
                throw VerifyError.timedOut(timeout)
            }
            try await Task.sleep(nanoseconds: 50_000_000) // 50ms poll
        }
        process.waitUntilExit()
        let output = String(data: dataBox.get(), encoding: .utf8) ?? ""
        // A guard stop must never be reported as a verification result: the
        // command was killed, so its exit code says nothing about the code under
        // test, and treating it as a failure would trigger an LLM repair while the
        // machine is already out of memory.
        if let reason = stopReason.get() {
            throw VerifyError.stoppedForResources(reason)
        }
        return VerifyOutcome(exitCode: process.terminationStatus, output: output)
    }
}

/// Thread-safe one-shot box for the guard's stop reason. The guard's handler runs
/// on its own queue while the awaiting task reads this after `waitUntilExit`.
private final class ResourceStopBox: @unchecked Sendable {
    private let lock = NSLock()
    private var reason: String?
    func set(_ r: String) { lock.lock(); if reason == nil { reason = r }; lock.unlock() }
    func get() -> String? { lock.lock(); defer { lock.unlock() }; return reason }
}

/// Tiny thread-safe box so the reader thread and the awaiting task can
/// hand the captured data across without a data race.
private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}
