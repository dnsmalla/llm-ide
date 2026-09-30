// Runs a fault's verify command as a local subprocess. A non-zero exit
// means the fault is present (regression); exit 0 means fixed. The
// command string is the agent-authored, user-approved verify command —
// nothing else reaches /bin/sh, and no fault content is interpolated
// into the command line.

import Foundation

struct VerifyOutcome: Equatable {
    let exitCode: Int32
    let output: String   // combined stdout + stderr
    /// True when the middle of the output was dropped by the capture cap
    /// (see `CappedOutputBuffer`). A caller that must see EVERY line — a git
    /// probe listing paths — treats this as "could not verify".
    var elided: Bool = false
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
    /// SIGTERM → SIGKILL grace for the command's process group.
    static let killGrace: TimeInterval = 1.0

    /// When false, output is captured in full (`uncapped()`); used only for
    /// probes whose output is paths/hashes that must never be elided.
    private let capped: Bool

    init() { capped = true }
    private init(capped: Bool) { self.capped = capped }

    /// A verifier that keeps ALL output. For git probes only: their output is
    /// bounded by the repository, and eliding the middle of a path list would
    /// hide exactly the path a guard must see.
    static func uncapped() -> ShellFaultVerifier { ShellFaultVerifier(capped: false) }

    /// Runs through `GroupedSubprocess`: the command leads its own process
    /// group, so Stop, a timeout and the ResourceGuard stop the WHOLE tree
    /// (this used to `terminate()` only `/bin/sh`, leaving `swift test`'s
    /// children running), and output is a capped head+tail capture that a
    /// backgrounded grandchild holding the pipe cannot empty.
    func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
        let proc: GroupedSubprocess
        do {
            let buffer = capped
                ? CappedOutputBuffer()
                : CappedOutputBuffer(headLimit: .max, tailLimit: 0)
            proc = try GroupedSubprocess.launch(shellCommand: command, directory: repoRoot,
                                                output: buffer)
        } catch {
            throw VerifyError.launchFailed(error.localizedDescription)
        }

        // `timeout <= 0` means no limit, which is now the default everywhere that
        // calls this: a verification command is the user's own test suite or
        // build, and killing it at an arbitrary mark reports "timed out" for a
        // stage that was simply still working.
        let deadline: Date? = timeout > 0 ? Date().addingTimeInterval(timeout) : nil
        // The machine, not the clock, is what stops an unbounded run. The reason
        // is recorded so the non-zero exit that follows the SIGTERM is reported as
        // a resource stop rather than as a failing test (see
        // VerifyError.stoppedForResources).
        let stopReason = ResourceStopBox()
        let guardToken = ResourceGuardService.shared.register(
            label: "verify: \(command.prefix(60))"
        ) { reason in
            stopReason.set(reason)
            guard !proc.hasExited else { return }
            proc.terminateTree(grace: Self.killGrace)
        }
        defer { guardToken.cancel() }
        // Cancellation (Loop Stop, app quit): `Task.sleep` below throws on its
        // own, so this `defer` is what stops the tree instead of orphaning a
        // `swift test`. It cannot await; `terminateTree` schedules the SIGKILL
        // and the reaper thread still collects the exit.
        defer { if !proc.hasExited { proc.terminateTree(grace: Self.killGrace) } }

        while !proc.hasExited {
            if let deadline, Date() >= deadline {
                proc.terminateTree(grace: 0.5)
                try? await proc.waitForExit()
                _ = await proc.collectOutput()
                throw VerifyError.timedOut(timeout)
            }
            try await Task.sleep(nanoseconds: 50_000_000) // 50ms poll
        }
        let output = await proc.collectOutput()
        // A guard stop must never be reported as a verification result: the
        // command was killed, so its exit code says nothing about the code under
        // test, and treating it as a failure would trigger an LLM repair while the
        // machine is already out of memory.
        if let reason = stopReason.get() {
            throw VerifyError.stoppedForResources(reason)
        }
        return VerifyOutcome(exitCode: proc.exitStatus ?? -1, output: output,
                             elided: proc.output.wasElided)
    }
}

/// Thread-safe one-shot box for the guard's stop reason. The guard's handler runs
/// on its own queue while the awaiting task reads this after the process exits.
private final class ResourceStopBox: @unchecked Sendable {
    private let lock = NSLock()
    private var reason: String?
    func set(_ r: String) { lock.lock(); if reason == nil { reason = r }; lock.unlock() }
    func get() -> String? { lock.lock(); defer { lock.unlock() }; return reason }
}
