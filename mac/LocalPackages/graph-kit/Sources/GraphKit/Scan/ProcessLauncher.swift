import Foundation

/// Minimal seam for running and testing external processes.
public protocol ProcessLauncher: Sendable {
    /// Run an executable and await its exit. Honors Task cancellation by
    /// terminating the child process. Returns (exitCode, stdoutData, stderrData).
    /// Throws `CancellationError` if cancelled.
    /// `currentDirectory`, when provided, sets the child's working directory.
    func run(executable: URL, arguments: [String], currentDirectory: URL?,
             environment: [String: String]?) async throws -> (Int32, Data, Data)
}

public extension ProcessLauncher {
    /// Convenience overload for callers that don't need a working directory.
    func run(executable: URL, arguments: [String],
             environment: [String: String]?) async throws -> (Int32, Data, Data) {
        try await run(executable: executable, arguments: arguments,
                      currentDirectory: nil, environment: environment)
    }
}

public struct SystemProcessLauncher: ProcessLauncher {
    public init() {}

    public func run(executable: URL, arguments: [String], currentDirectory: URL?,
                    environment: [String: String]?) async throws -> (Int32, Data, Data) {
        final class ProcBox: @unchecked Sendable {
            let lock = NSLock()
            var proc: Process?
            var cancelled = false
        }
        let box = ProcBox()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Int32, Data, Data), Error>) in
                let proc = Process()
                proc.executableURL = executable
                proc.arguments = arguments
                if let cwd = currentDirectory { proc.currentDirectoryURL = cwd }
                if let env = environment { proc.environment = env }
                let outPipe = Pipe(); let errPipe = Pipe()
                proc.standardOutput = outPipe
                proc.standardError = errPipe

                // Drain both pipes concurrently BEFORE the process exits.
                // Reading inside terminationHandler (after exit) deadlocks
                // when the child writes >64KB — the pipe buffer fills, the
                // child blocks on write, and it never exits.
                var outData = Data()
                var errData = Data()
                let readGroup = DispatchGroup()
                readGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                    readGroup.leave()
                }
                readGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                    readGroup.leave()
                }

                let lock = NSLock()
                var resumed = false
                func finish(_ result: Result<(Int32, Data, Data), Error>) {
                    lock.lock(); defer { lock.unlock() }
                    if resumed { return }
                    resumed = true
                    cont.resume(with: result)
                }

                proc.terminationHandler = { p in
                    // Wait for both readers to drain any remaining bytes.
                    readGroup.wait()

                    box.lock.lock()
                    let wasCancelled = box.cancelled
                    box.lock.unlock()
                    if wasCancelled {
                        finish(.failure(CancellationError()))
                    } else {
                        finish(.success((p.terminationStatus, outData, errData)))
                    }
                }

                box.lock.lock()
                box.proc = proc
                let alreadyCancelled = box.cancelled
                box.lock.unlock()
                if alreadyCancelled {
                    finish(.failure(CancellationError()))
                    return
                }
                do {
                    try proc.run()
                } catch {
                    finish(.failure(error))
                }
            }
        } onCancel: {
            box.lock.lock()
            box.cancelled = true
            let p = box.proc
            box.lock.unlock()
            if let p, p.isRunning { p.terminate() }
        }
    }
}
