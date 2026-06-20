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

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning {
            if Date() >= deadline {
                process.terminate()                 // SIGTERM
                throw VerifyError.timedOut(timeout)
            }
            try await Task.sleep(nanoseconds: 50_000_000) // 50ms poll
        }
        process.waitUntilExit()
        let output = String(data: dataBox.get(), encoding: .utf8) ?? ""
        return VerifyOutcome(exitCode: process.terminationStatus, output: output)
    }
}

/// Tiny thread-safe box so the reader thread and the awaiting task can
/// hand the captured data across without a data race.
private final class OutputBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
}
